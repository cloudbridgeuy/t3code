import { useEffect, useState, type ReactNode } from "react";

import { getCachedMermaidRender, renderMermaidDiagram } from "../../lib/mermaidRenderer";
import {
  hasMermaidDiagramToggle,
  mermaidFailureMessage,
  resolveMermaidView,
  type MermaidRenderState,
} from "./mermaidBlock.logic";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

/**
 * A mermaid fence, in one of two modes: the drawn diagram, or its source —
 * the same source text `MarkdownCodeBlock`'s copy button already writes to
 * the clipboard. `sourceView` is the caller's already-built Shiki code block
 * (the same one a non-mermaid fence renders), reused here so source mode
 * looks and behaves exactly like a normal code block.
 *
 * `fenceClosed` is the caller's answer to "has the closing fence for this
 * block actually arrived yet" — while streaming, this component mounts and
 * re-renders on every token, but `source` (the partial fence text) is not
 * something to attempt to render as a diagram. The render effect is gated on
 * `fenceClosed` so it never fires on partial source, and fires exactly once
 * when the fence closes (assuming `source`/`theme` are otherwise stable).
 *
 * That "otherwise stable" caveat matters more than it looks: the caller's
 * `pre` override is rebuilt on every streamed token (its memo depends on the
 * full message `text`), so once the fence has closed, React remounts this
 * component fresh on every subsequent token instead of just re-rendering it.
 * `renderState`'s initial value is seeded from `getCachedMermaidRender` so a
 * remount that already has a known result skips straight to it — no
 * pending flash, no repeat mermaid.render() call. See `mermaidRenderer.ts`.
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
  const [prefersSource, setPrefersSource] = useState(false);
  const [renderState, setRenderState] = useState<MermaidRenderState>(
    () =>
      (fenceClosed ? getCachedMermaidRender(source, theme) : undefined) ?? { status: "pending" },
  );

  useEffect(() => {
    if (!fenceClosed) {
      return;
    }
    // A remount (see the class comment above) re-runs this effect for a
    // source/theme pair that may already be cached. Reusing the cached
    // result here — instead of unconditionally resetting to pending first —
    // is what actually prevents the flash: `setRenderState` with the exact
    // object `getCachedMermaidRender` already seeded as the initial state is
    // a no-op render (React bails via Object.is on the unchanged reference).
    const cached = getCachedMermaidRender(source, theme);
    if (cached) {
      setRenderState(cached);
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
  }, [source, theme, fenceClosed]);

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
      code={source}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      {...mermaidToggleProps}
    >
      {view._tag === "Diagram" ? (
        <div
          className="chat-markdown-mermaid-diagram overflow-x-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          // Safe against untrusted diagram text: renderMermaidDiagram always
          // initializes mermaid with securityLevel "strict", which sanitizes
          // mermaid's own SVG output (confirmed by inspecting a rendered SVG
          // from malicious input: an injected <script> was stripped
          // outright). It does not disable HTML labels — those still render
          // as real HTML inside <foreignObject>.
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
