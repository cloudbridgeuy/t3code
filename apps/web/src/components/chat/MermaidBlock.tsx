import { useEffect, useState, type ReactNode } from "react";

import { renderMermaidDiagram } from "../../lib/mermaidRenderer";
import { resolveMermaidView, type MermaidRenderState } from "./mermaidBlock.logic";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

/**
 * A mermaid fence, in one of two modes: the drawn diagram, or its source —
 * the same source text `MarkdownCodeBlock`'s copy button already writes to
 * the clipboard. `sourceView` is the caller's already-built Shiki code block
 * (the same one a non-mermaid fence renders), reused here so source mode
 * looks and behaves exactly like a normal code block.
 */
export function MermaidBlock({
  source,
  fenceTitle,
  theme,
  sourceView,
}: {
  source: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  sourceView: ReactNode;
}) {
  const [prefersSource, setPrefersSource] = useState(false);
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: "pending" });

  useEffect(() => {
    let cancelled = false;
    setRenderState({ status: "pending" });
    renderMermaidDiagram(source, theme)
      .then((svg) => {
        if (!cancelled) {
          setRenderState({ status: "rendered", svg });
        }
      })
      .catch((error: unknown) => {
        console.error("[mermaid-block] failed to render diagram", error);
      });
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  const view = resolveMermaidView({ prefersSource, renderState });

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
          // initializes mermaid with securityLevel "strict", which disables
          // HTML labels and sanitizes mermaid's own SVG output.
          dangerouslySetInnerHTML={{ __html: view.svg }}
        />
      ) : (
        sourceView
      )}
    </MarkdownCodeBlock>
  );
}
