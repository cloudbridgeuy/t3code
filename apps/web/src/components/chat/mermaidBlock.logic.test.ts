import { describe, expect, it } from "vite-plus/test";

import {
  buildMermaidCopyFence,
  isFenceClosed,
  isMermaidFence,
  markdownCodeBlockActions,
  MERMAID_NATURAL_WIDTH_CSS_VAR,
  mermaidDiagramClassName,
  mermaidFailureMessage,
  parseMermaidNaturalWidth,
  resolveMermaidPresentation,
  resolveMermaidView,
} from "./mermaidBlock.logic";

describe("isMermaidFence", () => {
  it("accepts the mermaid fence language", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
  });

  it("accepts mermaid regardless of case", () => {
    expect(isMermaidFence("Mermaid")).toBe(true);
    expect(isMermaidFence("MERMAID")).toBe(true);
    expect(isMermaidFence("MerMaid")).toBe(true);
  });

  it("accepts mermaid with surrounding whitespace", () => {
    expect(isMermaidFence(" mermaid ")).toBe(true);
    expect(isMermaidFence("\tmermaid\n")).toBe(true);
  });

  it("rejects other fence languages", () => {
    expect(isMermaidFence("text")).toBe(false);
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("json")).toBe(false);
    expect(isMermaidFence("ini")).toBe(false);
  });

  it("rejects a language that merely contains mermaid", () => {
    expect(isMermaidFence("mermaid-js")).toBe(false);
    expect(isMermaidFence("notmermaid")).toBe(false);
  });

  it("rejects an empty language", () => {
    expect(isMermaidFence("")).toBe(false);
    expect(isMermaidFence("   ")).toBe(false);
  });
});

describe("resolveMermaidView", () => {
  it("shows Source when the user prefers source, even with a rendered SVG ready", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "rendered", svg: "<svg>ready</svg>" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("shows Source when the user prefers source and nothing has rendered yet", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "pending" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("shows Pending while the diagram has not rendered yet", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "pending" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Pending" });
  });

  it("shows Diagram with the rendered SVG once the render completes", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "rendered", svg: "<svg>diagram</svg>" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Diagram", svg: "<svg>diagram</svg>" });
  });

  it("shows Failed with the failure message once the render fails", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "Parse error on line 1" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Failed", message: "Parse error on line 1" });
  });

  it("keeps the source reachable after a failure, even without an explicit preference", () => {
    // A failed render never resolves to Diagram — the caller falls back to
    // rendering the same source view it uses for Pending and Failed alike,
    // so the user can still read (and copy) the mermaid text.
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "boom" },
      fenceClosed: true,
    });
    expect(view._tag).not.toBe("Diagram");
  });

  it("shows Source when the user prefers source, even after a failed render", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "failed", message: "boom" },
      fenceClosed: true,
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("shows Pending while the fence is still open, regardless of renderState", () => {
    // A block still streaming in has no complete diagram source to render —
    // an open fence always reads as Pending, even if a stale renderState
    // says otherwise (which should not happen in practice, but the pure
    // function does not trust the fence to stay closed once opened).
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "rendered", svg: "<svg>stale</svg>" },
      fenceClosed: false,
    });
    expect(view).toEqual({ _tag: "Pending" });
  });

  it("shows Pending while the fence is open even if the render already failed", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "boom" },
      fenceClosed: false,
    });
    expect(view).toEqual({ _tag: "Pending" });
  });

  it("shows Source when the user prefers source, even while the fence is still open", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "pending" },
      fenceClosed: false,
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("Failed keeps the source visible: it never resolves to Diagram, with or without an open fence", () => {
    const closed = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "boom" },
      fenceClosed: true,
    });
    const open = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "boom" },
      fenceClosed: false,
    });
    expect(closed._tag).not.toBe("Diagram");
    expect(open._tag).not.toBe("Diagram");
  });
});

describe("isFenceClosed", () => {
  // `fenceStart` mirrors what remark reports as `position.start.offset` for
  // a fenced code node: the offset of the fence's opening backtick run.
  const fenceStart = "before\n\n".length;

  it("is false for an open fence still streaming in (cut short by end of text)", () => {
    const text = "before\n\n```mermaid\ngraph TD\nA-->B";
    // Unterminated: remark extends the node's end to the end of input.
    const position = { start: { offset: fenceStart }, end: { offset: text.length } };
    expect(isFenceClosed(text, position, true)).toBe(false);
  });

  it("is true for a closed fence with content after it", () => {
    const closedFence = "```mermaid\ngraph TD\nA-->B\n```";
    const text = `before\n\n${closedFence}\n\nafter`;
    // Closed: remark's end offset lands right after the closing fence,
    // before the trailing blank line and "after".
    const position = {
      start: { offset: fenceStart },
      end: { offset: fenceStart + closedFence.length },
    };
    expect(isFenceClosed(text, position, true)).toBe(true);
  });

  it("is true for a fence whose closing marker is the very last text in the message", () => {
    const text = "before\n\n```mermaid\ngraph TD\nA-->B\n```";
    const position = { start: { offset: fenceStart }, end: { offset: text.length } };
    expect(isFenceClosed(text, position, true)).toBe(true);
  });

  it("falls back to !isStreaming when the position is missing", () => {
    const text = "```mermaid\ngraph TD\nA-->B";
    expect(isFenceClosed(text, undefined, true)).toBe(false);
    expect(isFenceClosed(text, undefined, false)).toBe(true);
  });
});

describe("mermaidDiagramClassName", () => {
  it('leaves the svg alone in fit mode, relying on mermaid\'s own width="100%"', () => {
    // Fit mode must keep behaving exactly as it does today: no width lever,
    // no forced (`!`) important cap.
    const className = mermaidDiagramClassName("fit");
    expect(className).toContain("[&_svg]:max-w-full");
    expect(className).not.toContain("max-w-none");
    expect(className).not.toContain("width");
    expect(className).not.toContain(MERMAID_NATURAL_WIDTH_CSS_VAR);
  });

  it("sets an explicit width and force-lifts the cap in natural mode", () => {
    const className = mermaidDiagramClassName("natural");
    // `!important` is required to beat mermaid's own inline `max-width`
    // style — a plain class rule cannot.
    expect(className).toContain("[&_svg]:max-w-none!");
    expect(className).not.toContain("max-w-full");
    // The width comes from the custom property the caller supplies, with a
    // fallback so an unset property doesn't collapse to the SVG default
    // 300x150 replaced-element size.
    expect(className).toContain("[&_svg]:w-[var(--mermaid-natural-width,100%)]");
  });

  it("keeps the literal class in sync with MERMAID_NATURAL_WIDTH_CSS_VAR", () => {
    // The class string must spell out the custom property name literally
    // (Tailwind never executes source, only scans it as text), while
    // `MermaidBlock` sets that same property from the exported constant. This
    // test is the one place allowed to interpolate the constant, so a rename
    // of one without the other fails here instead of silently losing the
    // Tailwind rule again.
    const className = mermaidDiagramClassName("natural");
    expect(className).toContain(`var(${MERMAID_NATURAL_WIDTH_CSS_VAR}`);
  });

  it("caps height and scrolls in both fit and natural mode, never just horizontally", () => {
    // A diagram keeps its aspect ratio, so a tall-relative-to-width diagram
    // grows exactly as tall as fit's full container width demands. Both
    // modes must cap that height and scroll rather than let the message grow.
    const fitClassName = mermaidDiagramClassName("fit");
    expect(fitClassName).toContain("overflow-auto");
    expect(fitClassName).not.toContain("overflow-x-auto");
    expect(fitClassName).toContain("max-h-[70vh]");

    const naturalClassName = mermaidDiagramClassName("natural");
    expect(naturalClassName).toContain("overflow-auto");
    expect(naturalClassName).not.toContain("overflow-x-auto");
    expect(naturalClassName).toContain("max-h-[70vh]");
  });
});

describe("parseMermaidNaturalWidth", () => {
  const svgHead = (attrs: string) =>
    `<svg aria-roledescription="flowchart-v2" role="graphics-document document" ${attrs} class="flowchart" xmlns="http://www.w3.org/2000/svg"><g>...</g></svg>`;

  it("reads the inline max-width, matching a real mermaid svg head", () => {
    const svg = svgHead(
      'viewBox="0.00000762939453125 0 1705.03125 1443.7879638671875" style="max-width: 1705.03125px;" width="100%"',
    );
    expect(parseMermaidNaturalWidth(svg)).toBe(1705.03125);
  });

  it("falls back to the viewBox's third value when there is no inline max-width", () => {
    const svg = svgHead('viewBox="0 0 640.5 320.25" width="100%"');
    expect(parseMermaidNaturalWidth(svg)).toBe(640.5);
  });

  it("returns undefined when neither an inline max-width nor a viewBox is present", () => {
    const svg = svgHead('width="100%"');
    expect(parseMermaidNaturalWidth(svg)).toBeUndefined();
  });

  it("returns undefined for a malformed viewBox width", () => {
    const svg = svgHead('viewBox="0 0 abc 100" width="100%"');
    expect(parseMermaidNaturalWidth(svg)).toBeUndefined();
  });

  it("returns undefined for a non-positive viewBox width", () => {
    const svg = svgHead('viewBox="0 0 0 100" width="100%"');
    expect(parseMermaidNaturalWidth(svg)).toBeUndefined();
  });

  it("returns undefined for a non-positive inline max-width", () => {
    const svg = svgHead('style="max-width: 0px;" viewBox="0 0 500 300" width="100%"');
    expect(parseMermaidNaturalWidth(svg)).toBeUndefined();
  });
});

describe("buildMermaidCopyFence", () => {
  it("wraps a diagram with no trailing newline in a ```mermaid fence (a shape that never occurs in production)", () => {
    const source = "graph TD\n  A --> B";
    expect(buildMermaidCopyFence(source)).toBe("```mermaid\ngraph TD\n  A --> B\n```\n\n");
  });

  it("strips the trailing newline mdast-util-to-hast adds to every fence", () => {
    // `MermaidBlock`'s `source` prop always ends in exactly one `\n` —
    // appended unconditionally by mdast-util-to-hast's `code` handler
    // (`node.value + '\n'`), not written by the diagram's author. Keeping
    // that newline would add a spurious blank line before the closing
    // fence on every single copy, so it must be stripped before rebuilding.
    const source = "graph TD\n  A --> B\n";
    expect(buildMermaidCopyFence(source)).toBe("```mermaid\ngraph TD\n  A --> B\n```\n\n");
  });

  it("recovers the human-authored fence content from the realistic (trailing-newline) input shape", () => {
    // `source` here is exactly what `MermaidBlock` always actually
    // receives: the human-authored code plus the one `\n` hast appends.
    // Stripping that appended newline before building must recover the
    // human-authored code itself, not the hast-augmented string.
    const code = "graph TD\n  A --> B";
    const fenced = buildMermaidCopyFence(`${code}\n`);
    const recovered = /^```mermaid\n([\s\S]*)\n```\n\n$/.exec(fenced)?.[1];
    expect(recovered).toBe(code);
  });

  it("matches serializeCodeBlock's output shape for the same fence in source mode", () => {
    // `serializeCodeBlock` (markdown-clipboard.ts:66-70) does
    // `code = pre.textContent.replace(/\n$/, "")` and then returns
    // `${fence}${language}\n${code}\n${fence}\n\n` — for a `<pre>` whose
    // resolved language is "mermaid" and whose `textContent` is
    // `code + "\n"` (the shape every real `<pre>` has), that is exactly
    // this string. These two paths must stay in step, or copying the same
    // fence in source mode vs. diagram mode produces different markdown.
    const code = "graph TD\n  A --> B";
    const fence = "```";
    expect(buildMermaidCopyFence(`${code}\n`)).toBe(`${fence}mermaid\n${code}\n${fence}\n\n`);
  });

  it("grows the fence past a triple-backtick run inside the source", () => {
    // CommonMark requires the fence to be longer than any backtick run it
    // encloses, and the closing fence to be at least as long as the
    // opener — a diagram whose text quotes a code span (e.g. a node label
    // like `` `A["```js``` "]` ``) is exactly this case for mermaid's own
    // source, which is untrusted, streamed, agent-authored text. Uses the
    // realistic trailing-newline shape, since that is the only one
    // `MermaidBlock` ever passes in production.
    const code = 'flowchart TD\n  A["```js\nconst x = 1\n```"]';
    const fenced = buildMermaidCopyFence(`${code}\n`);
    expect(fenced.startsWith("````mermaid\n")).toBe(true);
    expect(fenced.endsWith("\n````\n\n")).toBe(true);
    expect(fenced).toContain(code);
  });

  it("grows the fence past a run longer than three backticks", () => {
    const source = "flowchart TD\n  A[`````not really code`````]";
    const fenced = buildMermaidCopyFence(source);
    expect(fenced.startsWith("``````mermaid\n")).toBe(true);
    expect(fenced.endsWith("\n``````\n\n")).toBe(true);
  });
});

describe("markdownCodeBlockActions", () => {
  it("keeps today's wrap-only chrome for an ordinary code block", () => {
    expect(markdownCodeBlockActions(undefined, false)).toEqual(["wrap"]);
  });

  it("swaps wrap-lines for the size toggle once a diagram is actually visible", () => {
    expect(markdownCodeBlockActions("diagram", true)).toEqual(["mermaid-size", "mermaid-toggle"]);
  });

  it("keeps wrap-lines in diagram mode while no diagram has rendered yet", () => {
    // Diagram mode with nothing to size (still pending) keeps the toggle
    // in place but falls back to wrap-lines instead of the size control —
    // this is what lets the toggle stay put across a render's whole
    // lifetime without ever offering a size control with nothing to size.
    expect(markdownCodeBlockActions("diagram", false)).toEqual(["wrap", "mermaid-toggle"]);
  });

  it("keeps wrap-lines and adds the diagram toggle in source mode, even with a diagram ready", () => {
    // Source mode never shows the size toggle, regardless of diagramVisible
    // — the SVG isn't on screen, so there's nothing for it to size.
    expect(markdownCodeBlockActions("source", false)).toEqual(["wrap", "mermaid-toggle"]);
    expect(markdownCodeBlockActions("source", true)).toEqual(["wrap", "mermaid-toggle"]);
  });
});

describe("resolveMermaidPresentation", () => {
  // The behavior table this function implements, keyed by (fenceClosed,
  // renderMermaidPreferred, renderState.status):
  //
  // | fenceClosed | preferred | render    | view    | chromeMode |
  // |-------------|-----------|-----------|---------|------------|
  // | false       | either    | any       | code    | (none)     |
  // | true        | false     | any       | source  | source     |
  // | true        | true      | pending   | code    | diagram    |
  // | true        | true      | rendered  | diagram | diagram    |
  // | true        | true      | failed    | error   | (none)     |

  it("shows the code block with no chrome while the fence is still open, regardless of preference", () => {
    const preferringDiagram = resolveMermaidPresentation({
      renderMermaidPreferred: true,
      renderState: { status: "rendered", svg: "<svg></svg>" },
      fenceClosed: false,
    });
    expect(preferringDiagram.view).toEqual({ _tag: "Pending" });
    expect(preferringDiagram.chromeMode).toBeUndefined();

    const preferringSource = resolveMermaidPresentation({
      renderMermaidPreferred: false,
      renderState: { status: "pending" },
      fenceClosed: false,
    });
    expect(preferringSource.view).toEqual({ _tag: "Source" });
    expect(preferringSource.chromeMode).toBeUndefined();
  });

  it("shows source with a source-mode toggle when the user does not prefer mermaid rendering, whatever the render's own progress", () => {
    // Once the user prefers source, chromeMode stays "source" regardless of
    // renderState — unlike the diagram-preferred rows below, where a failed
    // render does drop the chrome.
    for (const renderState of [
      { status: "pending" as const },
      { status: "rendered" as const, svg: "<svg>ready</svg>" },
      { status: "failed" as const, message: "boom" },
    ]) {
      const result = resolveMermaidPresentation({
        renderMermaidPreferred: false,
        renderState,
        fenceClosed: true,
      });
      expect(result.view).toEqual({ _tag: "Source" });
      expect(result.chromeMode).toBe("source");
    }
  });

  it("shows the code block with a diagram-mode toggle while a preferred render is still pending", () => {
    // This is the row that removes the flicker: the toggle is already in
    // "diagram" mode (label "Show source") before the SVG exists, so
    // clicking it never has to wait on the render, and the render landing
    // never has to swap the toggle in or out from under the user.
    const result = resolveMermaidPresentation({
      renderMermaidPreferred: true,
      renderState: { status: "pending" },
      fenceClosed: true,
    });
    expect(result.view).toEqual({ _tag: "Pending" });
    expect(result.chromeMode).toBe("diagram");
  });

  it("shows the diagram with a diagram-mode toggle once a preferred render completes", () => {
    const result = resolveMermaidPresentation({
      renderMermaidPreferred: true,
      renderState: { status: "rendered", svg: "<svg>done</svg>" },
      fenceClosed: true,
    });
    expect(result.view).toEqual({ _tag: "Diagram", svg: "<svg>done</svg>" });
    expect(result.chromeMode).toBe("diagram");
  });

  it("shows the error and source with no chrome once a preferred render permanently fails", () => {
    // Unlike the pending row, a failed render has nothing left to toggle
    // to, and never will on its own — so unlike pending, this row drops
    // the chrome entirely rather than keeping a toggle with nothing behind
    // it.
    const result = resolveMermaidPresentation({
      renderMermaidPreferred: true,
      renderState: { status: "failed", message: "bad diagram" },
      fenceClosed: true,
    });
    expect(result.view).toEqual({ _tag: "Failed", message: "bad diagram" });
    expect(result.chromeMode).toBeUndefined();
  });

  it("inverts the stored preference into prefersSource, covering both stored values", () => {
    // The polarity itself: `renderMermaidPreferred` is "should this render
    // as a diagram", so `true` must read as NOT preferring source and
    // `false` must read as preferring source. A flipped inversion here
    // would silently break "reload keeps the chosen mode".
    const whenPreferred = resolveMermaidPresentation({
      renderMermaidPreferred: true,
      renderState: { status: "pending" },
      fenceClosed: true,
    });
    expect(whenPreferred.prefersSource).toBe(false);

    const whenNotPreferred = resolveMermaidPresentation({
      renderMermaidPreferred: false,
      renderState: { status: "pending" },
      fenceClosed: true,
    });
    expect(whenNotPreferred.prefersSource).toBe(true);
  });
});

describe("mermaidFailureMessage", () => {
  it("reads the message off an Error", () => {
    expect(mermaidFailureMessage(new Error("bad diagram"))).toBe("bad diagram");
  });

  it("reads the message off an Error subclass", () => {
    class MermaidParseError extends Error {}
    expect(mermaidFailureMessage(new MermaidParseError("unexpected token"))).toBe(
      "unexpected token",
    );
  });

  it("passes through a thrown string as-is", () => {
    expect(mermaidFailureMessage("plain string failure")).toBe("plain string failure");
  });

  it("falls back to a generic message for a non-Error, non-string rejection", () => {
    expect(mermaidFailureMessage({ code: 42 })).toBe("Failed to render diagram.");
    expect(mermaidFailureMessage(undefined)).toBe("Failed to render diagram.");
    expect(mermaidFailureMessage(null)).toBe("Failed to render diagram.");
  });
});
