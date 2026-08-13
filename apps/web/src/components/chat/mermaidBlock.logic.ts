/**
 * Pure decisions for rendering a mermaid fence as a diagram: which fence
 * languages count as mermaid, and what a mermaid block should show given its
 * current mode and render progress. No DOM access, no mermaid import — the
 * shell (MermaidBlock.tsx, lib/mermaidRenderer.ts) owns every effect.
 */

const MERMAID_FENCE_LANGUAGE = "mermaid";

/** `language` is already normalized by `extractFenceLanguage` (lowercased is
 * not guaranteed — fence text keeps its original case), so this still trims
 * and lowercases defensively before comparing. */
export function isMermaidFence(language: string): boolean {
  return language.trim().toLowerCase() === MERMAID_FENCE_LANGUAGE;
}

/** How far the diagram render has gotten: no SVG yet, a rendered SVG in
 * hand, or the render failed and will not be retried on its own. */
export type MermaidRenderState =
  | { readonly status: "pending" }
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "failed"; readonly message: string };

/**
 * What a mermaid block should present. A closed set — `Diagram` always
 * carries the SVG it draws, so "showing a diagram" and "having nothing to
 * show" cannot be confused. `Failed` carries the message so a failed render
 * is representable rather than laundered into a permanent `Pending`.
 */
export type MermaidView =
  | { readonly _tag: "Source" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Diagram"; readonly svg: string }
  | { readonly _tag: "Failed"; readonly message: string };

export const MermaidView = {
  Source: (): MermaidView => ({ _tag: "Source" }),
  Pending: (): MermaidView => ({ _tag: "Pending" }),
  Diagram: (svg: string): MermaidView => ({ _tag: "Diagram", svg }),
  Failed: (message: string): MermaidView => ({ _tag: "Failed", message }),
} as const;

/**
 * The user's explicit choice to see source always wins. Otherwise the view
 * follows the render: no SVG yet reads as `Pending` (presented as the same
 * code block as `Source`, so the user never sees an empty box), an SVG in
 * hand reads as `Diagram`, and a failure reads as `Failed` — currently
 * presented as the source view too, since there is no failure notice UI yet.
 */
export function resolveMermaidView(input: {
  readonly prefersSource: boolean;
  readonly renderState: MermaidRenderState;
}): MermaidView {
  if (input.prefersSource) {
    return MermaidView.Source();
  }
  switch (input.renderState.status) {
    case "rendered":
      return MermaidView.Diagram(input.renderState.svg);
    case "failed":
      return MermaidView.Failed(input.renderState.message);
    case "pending":
      return MermaidView.Pending();
  }
}

/** Pulls a human-readable message out of whatever a render rejected with.
 * `Error` values read as their `.message`; anything else (a thrown string,
 * a rejected non-Error) is coerced so a failure never surfaces as
 * `"[object Object]"` or `undefined`. */
export function mermaidFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Failed to render diagram.";
}
