import { useEffect, useState, type ReactNode } from "react";

import { renderMermaidDiagram } from "../../lib/mermaidRenderer";
import {
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
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: "pending" });

  useEffect(() => {
    if (!fenceClosed) {
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

  return (
    <MarkdownCodeBlock
      code={source}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      mermaidToggle={{ showingSource: prefersSource, onToggle: () => setPrefersSource((v) => !v) }}
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
