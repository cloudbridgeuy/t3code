import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNearViewport } from "../../hooks/useNearViewport";
import {
  getCachedMermaidRender,
  mermaidRenderCacheKey,
  mermaidSourceKey,
  renderMermaidDiagram,
} from "../../lib/mermaidRenderer";
import {
  buildMermaidCopyFence,
  MERMAID_NATURAL_WIDTH_CSS_VAR,
  mermaidDiagramClassName,
  mermaidFailureMessage,
  parseMermaidNaturalWidth,
  resolveMermaidPresentation,
  type MermaidRenderState,
  type MermaidSizeMode,
} from "./mermaidBlock.logic";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

// A global preference, not per-block: switching one diagram to source and
// reloading is meant to reopen every mermaid block in source mode.
const RENDER_MERMAID_STORAGE_KEY = "t3code.renderMermaid";

// Renders the swap from code block to diagram slightly before the block is
// on screen, so the height change it causes never reflows a visible timeline.
const NEAR_VIEWPORT_ROOT_MARGIN = "400px";

// `MermaidBlock` remounts on every streamed token once its fence has closed
// (see mermaidRenderer.ts), re-arming `useNearViewport`'s observer from
// scratch each time. A fast stream can retire a remount before the
// observer's first notification lands. Remembering a key here once any
// instance for it does observe an intersection lets a later remount seed
// `nearViewport` as already-true instead of re-racing that observer.
const seenNearViewport = new Set<string>();

// `sizeMode` lives here for the same remount-survival reason as
// `seenNearViewport` above — but keyed on source alone (via
// `mermaidSourceKey`, not `mermaidRenderCacheKey`) so switching themes
// doesn't drop the user's chosen size. Only diagrams currently expanded to
// natural size get an entry, deleted again once the block returns to fit, so
// this stays bounded by how many diagrams a user has actually expanded
// rather than growing with every diagram ever seen.
const naturalSizeMermaidDiagrams = new Set<string>();

/**
 * A mermaid fence, in one of two modes: the drawn diagram, or `sourceView`
 * (the caller's already-built Shiki block, reused so source mode looks like
 * a normal code block). The render effect only runs once `fenceClosed` is
 * true, so a still-streaming fence is never handed to mermaid as a diagram.
 *
 * `ChatMarkdown` remounts this component on every streamed token once the
 * fence has closed, so `renderState` seeds from `getCachedMermaidRender`: a
 * cache hit skips straight to the known result instead of flashing back to
 * pending. See `mermaidRenderer.ts` for why that remount happens and how the
 * cache handles it.
 */
export function MermaidBlock({
  source,
  fenceTitle,
  theme,
  sourceView,
  fenceClosed,
}: {
  source: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  sourceView: ReactNode;
  fenceClosed: boolean;
}) {
  // Backed by localStorage (not component state) so the preference survives
  // this component's frequent mid-stream remounts instead of resetting to
  // diagram mode on the next token.
  const [renderMermaidPreferred, setRenderMermaidPreferred] = useLocalStorage(
    RENDER_MERMAID_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const sourceKey = mermaidSourceKey(source);
  // Seeded from (and kept in sync with) `naturalSizeMermaidDiagrams` rather
  // than always starting at "fit" — see that set's comment for why a plain
  // `useState("fit")` here would snap an expanded diagram back to fit on the
  // next streamed token.
  const [sizeMode, setSizeMode] = useState<MermaidSizeMode>(() =>
    naturalSizeMermaidDiagrams.has(sourceKey) ? "natural" : "fit",
  );
  const handleSizeModeChange = (nextSizeMode: MermaidSizeMode) => {
    if (nextSizeMode === "natural") {
      naturalSizeMermaidDiagrams.add(sourceKey);
    } else {
      naturalSizeMermaidDiagrams.delete(sourceKey);
    }
    setSizeMode(nextSizeMode);
  };
  const [renderState, setRenderState] = useState<MermaidRenderState>(
    () =>
      (fenceClosed ? getCachedMermaidRender(source, theme) : undefined) ?? { status: "pending" },
  );

  // State, not a ref, so this effect re-runs once the node mounts — a ref
  // read here could run before the node exists and never arm the observer.
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const cacheKey = mermaidRenderCacheKey(source, theme);
  const nearViewport = useNearViewport(
    viewportNode,
    NEAR_VIEWPORT_ROOT_MARGIN,
    seenNearViewport.has(cacheKey),
  );
  const { view, prefersSource, chromeMode } = resolveMermaidPresentation({
    renderMermaidPreferred,
    renderState,
    fenceClosed,
  });

  useEffect(() => {
    if (!fenceClosed) {
      return;
    }
    if (nearViewport) {
      seenNearViewport.add(cacheKey);
    }
    // Reusing the cached result (rather than resetting to pending first) is
    // what prevents the flash: the same object reference is a no-op
    // setState. Left ungated by `nearViewport` — an on-screen diagram must
    // not flash back to pending just because this remount's observer
    // hasn't reported in yet.
    const cached = getCachedMermaidRender(source, theme);
    if (cached) {
      setRenderState(cached);
      return;
    }
    if (!nearViewport) {
      return;
    }
    if (prefersSource) {
      // The cache read above still runs — a cached SVG is free and makes
      // toggling back to diagram instant — but a user who prefers source
      // gets no `import("mermaid")` and no render for a diagram they've said
      // they don't want to see.
      return;
    }
    let cancelled = false;
    setRenderState({ status: "pending" });
    renderMermaidDiagram(source, theme)
      .then((result) => {
        if (!cancelled) {
          setRenderState(result);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[mermaid-block] failed to render diagram", error);
        setRenderState({ status: "failed", message: mermaidFailureMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [source, theme, fenceClosed, nearViewport, cacheKey, prefersSource]);

  // `exactOptionalPropertyTypes` treats an explicit `mermaid: undefined` as
  // different from the prop being absent, so the chrome is spread in rather
  // than passed as `undefined` when there is no chrome to show.
  const mermaidChromeProps = chromeMode
    ? {
        mermaid: {
          mode: chromeMode,
          diagramVisible: view._tag === "Diagram",
          onToggleMode: () => setRenderMermaidPreferred((v) => !v),
          sizeMode,
          onSizeModeChange: handleSizeModeChange,
        },
      }
    : {};

  // Memoized on the SVG string alone so this doesn't re-parse on every one
  // of this component's frequent mid-stream remounts.
  const diagramSvg = view._tag === "Diagram" ? view.svg : undefined;
  const naturalWidthPx = useMemo(
    () => (diagramSvg ? parseMermaidNaturalWidth(diagramSvg) : undefined),
    [diagramSvg],
  );
  // Same `exactOptionalPropertyTypes` treatment as `mermaidChromeProps`
  // above: spread the style in rather than pass `style={undefined}` when
  // there is nothing to set (fit mode ignores the property; natural mode
  // falls back to it via CSS, see `mermaidDiagramClassName`).
  const mermaidDiagramStyleProps =
    naturalWidthPx == null
      ? {}
      : {
          style: {
            [MERMAID_NATURAL_WIDTH_CSS_VAR]: `${naturalWidthPx}px`,
          } as CSSProperties,
        };

  return (
    <MarkdownCodeBlock
      // Observed directly rather than via a wrapper element, which would
      // sit between this and `.chat-markdown`'s `:first-child`/`:last-child`
      // margin reset and reintroduce spacing for a message that opens or
      // closes with a diagram.
      ref={setViewportNode}
      code={source}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      {...mermaidChromeProps}
    >
      {view._tag === "Diagram" ? (
        <div
          className={mermaidDiagramClassName(sizeMode)}
          {...mermaidDiagramStyleProps}
          // Without this, copying a message containing this block would
          // drop it silently: `markdown-clipboard.ts` skips every `<svg>`
          // (untrusted mermaid output isn't safe to hand to a rich-paste
          // target), and this div's only child is one — so the serializer
          // would otherwise walk in, hit the svg, and contribute nothing.
          // Set here (not on the Failed or Source views below) because
          // those already round-trip on their own: `sourceView` is a plain
          // `<pre>`, which the serializer's generic code-block branch
          // already reconstructs correctly from `data-language` and text
          // content, with no diagram markup in the way.
          data-markdown-copy={buildMermaidCopyFence(source)}
          // Safe against untrusted diagram text — mermaid sanitizes its own
          // SVG output at `securityLevel: "strict"`; see mermaidRenderer.ts.
          dangerouslySetInnerHTML={{ __html: view.svg }}
        />
      ) : view._tag === "Failed" ? (
        <>
          <p
            role="alert"
            className="chat-markdown-mermaid-error border-b border-border/70 px-3 py-1.5 text-xs text-destructive dark:border-transparent"
          >
            {view.message}
          </p>
          {sourceView}
        </>
      ) : (
        sourceView
      )}
    </MarkdownCodeBlock>
  );
}
