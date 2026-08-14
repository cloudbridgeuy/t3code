import { useEffect, useState, type ReactNode } from "react";

import { useNearViewport } from "../../hooks/useNearViewport";
import { getCachedMermaidRender, renderMermaidDiagram } from "../../lib/mermaidRenderer";
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

  // Held in state, not a ref, so this effect re-runs once the node mounts —
  // an effect reading a ref could run before the node exists and never arm
  // the observer. `viewportNode` is `MarkdownCodeBlock`'s own root div
  // (passed through via its `ref` prop below), which is the single element
  // this component always returns regardless of view branch, so the
  // observer survives a mode switch instead of being torn down and
  // recreated.
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const nearViewport = useNearViewport(viewportNode, NEAR_VIEWPORT_ROOT_MARGIN);

  useEffect(() => {
    if (!fenceClosed) {
      return;
    }
    // Reusing the cached result here, instead of resetting to pending
    // first, is what prevents the flash: `setRenderState` with the same
    // object `getCachedMermaidRender` already seeded as initial state is a
    // no-op render (React bails via Object.is on the unchanged reference).
    // This read is unconditional on `nearViewport` — a remount's observer
    // callback hasn't fired yet, so gating the cache read too would flash
    // an already-rendered, on-screen diagram back to pending on every token.
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
  }, [source, theme, fenceClosed, nearViewport]);

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
      // Observed directly rather than via an extra wrapping element: a
      // wrapper would sit between this and `.chat-markdown`'s
      // `:first-child`/`:last-child` margin reset, reintroducing spacing
      // for a message that opens or closes with a diagram. This div is a
      // plain block box (never `display: contents`) present across every
      // view branch below, so the observer survives a mode switch instead
      // of being torn down and recreated.
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
