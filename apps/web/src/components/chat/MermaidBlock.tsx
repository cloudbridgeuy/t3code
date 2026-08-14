import { useEffect, useState, type ReactNode } from "react";

import { useNearViewport } from "../../hooks/useNearViewport";
import {
  getCachedMermaidRender,
  mermaidRenderCacheKey,
  renderMermaidDiagram,
} from "../../lib/mermaidRenderer";
import {
  hasMermaidDiagramToggle,
  mermaidFailureMessage,
  resolveMermaidView,
  type MermaidRenderState,
} from "./mermaidBlock.logic";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

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
  // Known limitation: this resets to `false` on every remount, so toggling
  // to source mid-stream gets reverted by the next token. Narrow in
  // practice — once streaming ends the remounts stop and the toggle holds.
  // A real fix needs the toggle state to survive a remount (a ref, lifted
  // state, or persistence); not worth adding for a window this short.
  const [prefersSource, setPrefersSource] = useState(false);
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
  }, [source, theme, fenceClosed, nearViewport, cacheKey]);

  const view = resolveMermaidView({ prefersSource, renderState, fenceClosed });
  // `exactOptionalPropertyTypes` treats an explicit `mermaidToggle: undefined` as
  // different from the prop being absent, so the toggle is spread in rather than
  // passed as `undefined` when there is no diagram yet to toggle to.
  const mermaidToggleProps = hasMermaidDiagramToggle(renderState)
    ? {
        mermaidToggle: {
          showingSource: prefersSource,
          onToggle: () => setPrefersSource((v) => !v),
        },
      }
    : {};

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
      {...mermaidToggleProps}
    >
      {view._tag === "Diagram" ? (
        <div
          className="chat-markdown-mermaid-diagram overflow-x-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
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
