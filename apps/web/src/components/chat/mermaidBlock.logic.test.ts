import { describe, expect, it } from "vite-plus/test";

import {
  hasMermaidDiagramToggle,
  isFenceClosed,
  isMermaidFence,
  mermaidFailureMessage,
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

describe("hasMermaidDiagramToggle", () => {
  it("hides the toggle while there is no diagram yet (pending)", () => {
    expect(hasMermaidDiagramToggle({ status: "pending" })).toBe(false);
  });

  it("hides the toggle when the render failed — the source is already on screen", () => {
    expect(hasMermaidDiagramToggle({ status: "failed", message: "boom" })).toBe(false);
  });

  it("shows the toggle once a diagram has rendered, so the user can switch to source", () => {
    // hasMermaidDiagramToggle only looks at renderState — prefersSource is a
    // separate axis the caller combines it with. A user who has already
    // switched to source still needs this same control to switch back to
    // the diagram that is known to exist, which is why the check is on
    // renderState rather than "not currently showing source".
    expect(hasMermaidDiagramToggle({ status: "rendered", svg: "<svg></svg>" })).toBe(true);
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
