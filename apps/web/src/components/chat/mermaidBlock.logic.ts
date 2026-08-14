/**
 * Decides which fence languages count as mermaid, and what a mermaid block
 * should show given its current mode and render progress.
 */

const MERMAID_FENCE_LANGUAGE = "mermaid";

/** `extractFenceLanguage` returns the fence language as typed, so this trims
 * and lowercases before comparing. */
export function isMermaidFence(language: string): boolean {
  return language.trim().toLowerCase() === MERMAID_FENCE_LANGUAGE;
}

/** Minimal shape of a hast/mdast node's `position` — enough to check whether
 * a fence's closing marker has arrived, and structurally compatible with the
 * real (richer) `Position` type react-markdown hands its component
 * overrides. Matches the pattern ChatMarkdown's `li` override already uses
 * for `node?.position?.start.offset`. */
export interface MermaidFencePosition {
  readonly start?: { readonly offset?: number | undefined };
  readonly end?: { readonly offset?: number | undefined };
}

/** Matches a line's leading run of three-or-more backticks or three-or-more
 * tildes, capturing that run. Used to find which marker opened a fence and
 * how long it was, because CommonMark requires the closing run to use the
 * same character and be at least as long. */
const FENCE_MARKER_PATTERN = /^(`{3,}|~{3,})/;

/**
 * Whether the mermaid fence `position` spans has a closing marker already in
 * `text`, as opposed to having been cut short by the end of a still-streaming
 * message. An unterminated fenced code block is extended by the markdown
 * parser all the way to the end of input, so the raw slice from
 * `position.start` to `position.end` ends with real code — never a bare run
 * of backticks or tildes — until the closing fence has actually arrived.
 *
 * When `position` (or either offset) is missing, there is nothing to check
 * against, so this falls back to `!isStreaming`: a finished message can
 * never have an open fence, and a still-streaming one might.
 */
export function isFenceClosed(
  text: string,
  position: MermaidFencePosition | undefined,
  isStreaming: boolean,
): boolean {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (start == null || end == null) {
    return !isStreaming;
  }
  const lines = text.slice(start, end).split("\n");
  const openingFence = FENCE_MARKER_PATTERN.exec(lines[0] ?? "");
  const openingMarker = openingFence?.[1];
  if (!openingMarker || lines.length < 2) {
    return !isStreaming;
  }
  const closingLine = (lines[lines.length - 1] ?? "").trim();
  const closingPattern = openingMarker[0] === "~" ? /^~{3,}$/ : /^`{3,}$/;
  return closingPattern.test(closingLine) && closingLine.length >= openingMarker.length;
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
 * The user's explicit choice to see source always wins. Otherwise, while the
 * fence is still open (streaming in), the view is always `Pending` —
 * regardless of `renderState` — since there is no complete diagram source to
 * render yet and no attempt should be made to render one. Once the fence has
 * closed, the view follows the render: no SVG yet reads as `Pending`
 * (presented as the same code block as `Source`, so the user never sees an
 * empty box or a spinner claiming work that isn't happening), an SVG in hand
 * reads as `Diagram`, and a failure reads as `Failed`.
 */
export function resolveMermaidView(input: {
  readonly prefersSource: boolean;
  readonly renderState: MermaidRenderState;
  readonly fenceClosed: boolean;
}): MermaidView {
  if (input.prefersSource) {
    return MermaidView.Source();
  }
  if (!input.fenceClosed) {
    return MermaidView.Pending();
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

/**
 * Whether the header's source/diagram toggle should render at all.
 *
 * The toggle is only honest once a diagram actually exists to switch
 * to — `renderState.status === "rendered"` covers both directions: while
 * `prefersSource` is false it offers the way to source, and once the user
 * has switched to source (`prefersSource` true) it still offers the way
 * back, because `renderState` does not change when the user's preference
 * does. Before a diagram exists — fence still open, still pending, or the
 * render failed — there is nothing to toggle to, so the control does not
 * appear; an open fence, a pending render, and a failed render all already
 * fall through to the code block (or the code block plus an error message)
 * on their own.
 */
export function hasMermaidDiagramToggle(renderState: MermaidRenderState): boolean {
  return renderState.status === "rendered";
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
