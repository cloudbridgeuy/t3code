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

/** `fit` relies on mermaid's own root `<svg width="100%">` presentation
 * attribute — any CSS `width` beats a presentation attribute, so leaving it
 * alone is what makes fit work today. `natural` has to override that
 * attribute itself with an explicit CSS `width`, then leans on the
 * container scrolling both axes (capped in height) instead. */
export type MermaidSizeMode = "fit" | "natural";

/** Custom property `mermaidDiagramClassName`'s natural-mode width reads
 * from; `MermaidBlock` sets it inline from `parseMermaidNaturalWidth`. */
export const MERMAID_NATURAL_WIDTH_CSS_VAR = "--mermaid-natural-width";

const MERMAID_DIAGRAM_BASE_CLASS_NAME = "chat-markdown-mermaid-diagram p-3 [&_svg]:h-auto";

/**
 * `fit`: mermaid's own `width="100%"` presentation attribute already fits
 * the diagram to its container, so this leaves the svg alone and scrolls
 * horizontally only, exactly as before. `natural`: a CSS `width` beats that
 * attribute, so this sets one from `MERMAID_NATURAL_WIDTH_CSS_VAR` (with a
 * `100%` fallback, so a block whose natural width couldn't be parsed
 * degrades to fit instead of collapsing to the SVG default replaced-element
 * size). It also force-lifts mermaid's own inline `max-width` — being an
 * inline style, only an `!important` rule can override it — so a wide
 * diagram in a wide container isn't still held to the cap mermaid computed
 * for itself. Since the SVG keeps its own aspect ratio (`[&_svg]:h-auto`
 * above), a wide diagram is also a tall one, so natural mode caps the
 * container's own height and scrolls both axes instead of stretching the
 * chat message to the diagram's full height.
 */
export function mermaidDiagramClassName(sizeMode: MermaidSizeMode): string {
  if (sizeMode === "fit") {
    return `${MERMAID_DIAGRAM_BASE_CLASS_NAME} overflow-x-auto [&_svg]:max-w-full`;
  }
  // Tailwind scans source text without executing it, so this custom property
  // name must be written literally here, not interpolated from
  // `MERMAID_NATURAL_WIDTH_CSS_VAR` — an interpolated class produces no rule.
  // It appears twice on purpose: keep this copy in sync with the constant.
  return `${MERMAID_DIAGRAM_BASE_CLASS_NAME} overflow-auto max-h-[70vh] [&_svg]:max-w-none! [&_svg]:w-[var(--mermaid-natural-width,100%)]`;
}

/** How far into a rendered SVG string to look for the root `<svg>` tag's
 * attributes. Real mermaid output puts them well within this, and reading
 * only the head keeps this parser out of the business of scanning a whole
 * (possibly large) diagram body. */
const SVG_HEAD_LENGTH = 2048;

/** Mermaid's own inline cap: `style="...max-width: 1705.03125px;..."` on the
 * root svg. Checked first since it is already the exact pixel figure mermaid
 * derived for this diagram. */
const INLINE_MAX_WIDTH_PATTERN = /<svg\b[^>]*\bstyle="[^"]*max-width:\s*([0-9.]+)px/;

/** Fallback source: the root svg's `viewBox="minX minY width height"`. Used
 * when a future mermaid config drops the inline cap. */
const VIEW_BOX_PATTERN = /<svg\b[^>]*\bviewBox="([^"]*)"/;

/**
 * The diagram's natural CSS width in pixels, read from the head of a
 * rendered mermaid SVG string — its inline `max-width`, or failing that the
 * third (width) value of its `viewBox`. `undefined` when neither is present,
 * or the one found does not parse to a finite, positive number. DOM-free and
 * string-only so it runs the same in a `node` test environment as in the
 * browser.
 */
export function parseMermaidNaturalWidth(svg: string): number | undefined {
  const head = svg.slice(0, SVG_HEAD_LENGTH);
  const inlineMaxWidth = INLINE_MAX_WIDTH_PATTERN.exec(head)?.[1];
  const viewBox = VIEW_BOX_PATTERN.exec(head)?.[1];
  const raw = inlineMaxWidth ?? viewBox?.trim().split(/\s+/)[2];
  if (raw == null) {
    return undefined;
  }
  const width = Number(raw);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

/** Which of the two chrome layouts a mermaid block's header should show —
 * "diagram" while the user wants to see one (whether or not it has rendered
 * yet), "source" once they have switched away from it. Unlike `MermaidView`,
 * this tracks the user's preference rather than render progress, which is
 * what keeps the toggle from flickering while a render is in flight; see
 * `resolveMermaidPresentation`. */
export type MermaidChromeMode = "diagram" | "source";

/** The header actions `MarkdownCodeBlock` renders before the always-present
 * copy button, and in the order they render. No chrome mode (an ordinary
 * code block, or a mermaid block with nothing to toggle to) keeps today's
 * wrap-lines-only chrome. Diagram mode shows the fit/natural size toggle in
 * place of wrap-lines, but only once `diagramVisible` — an SVG is actually
 * on screen; a diagram-preferred block still waiting on its render has
 * nothing to size yet, so it keeps wrap-lines like source mode does. */
export type MarkdownCodeBlockAction = "wrap" | "mermaid-size" | "mermaid-toggle";

export function markdownCodeBlockActions(
  mermaidMode: MermaidChromeMode | undefined,
  diagramVisible: boolean,
): ReadonlyArray<MarkdownCodeBlockAction> {
  if (!mermaidMode) {
    return ["wrap"];
  }
  return mermaidMode === "diagram" && diagramVisible
    ? ["mermaid-size", "mermaid-toggle"]
    : ["wrap", "mermaid-toggle"];
}

/**
 * What a mermaid block shows, and which chrome mode its header uses, as one
 * function of the three inputs that decide both: the persisted render
 * preference, the render's progress, and whether the fence has closed.
 *
 * `renderMermaidPreferred` is the raw stored value ("should this render as a
 * diagram"); inverting it into `prefersSource` here, rather than at the call
 * site, is what puts that inversion under test instead of leaving it as an
 * untested inline expression.
 *
 * `chromeMode` is absent (no chrome at all) only while the fence is still
 * open — nothing has streamed in to toggle yet — or once a diagram-preferred
 * render has permanently failed, since the failure view already shows the
 * source with no diagram to offer switching back to. Every other case gets a
 * `chromeMode`, including a diagram-preferred render that is still pending:
 * the toggle stays put and only its label changes once the SVG lands,
 * instead of appearing or disappearing out from under the user's cursor.
 */
export function resolveMermaidPresentation(input: {
  readonly renderMermaidPreferred: boolean;
  readonly renderState: MermaidRenderState;
  readonly fenceClosed: boolean;
}): {
  readonly view: MermaidView;
  readonly prefersSource: boolean;
  readonly chromeMode?: MermaidChromeMode;
} {
  const prefersSource = !input.renderMermaidPreferred;
  const view = resolveMermaidView({
    prefersSource,
    renderState: input.renderState,
    fenceClosed: input.fenceClosed,
  });
  if (!input.fenceClosed || (!prefersSource && input.renderState.status === "failed")) {
    return { view, prefersSource };
  }
  return { view, prefersSource, chromeMode: prefersSource ? "source" : "diagram" };
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
