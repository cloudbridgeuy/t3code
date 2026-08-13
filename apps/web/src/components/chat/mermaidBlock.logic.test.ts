import { describe, expect, it } from "vite-plus/test";

import { isMermaidFence, mermaidFailureMessage, resolveMermaidView } from "./mermaidBlock.logic";

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
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("shows Source when the user prefers source and nothing has rendered yet", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "pending" },
    });
    expect(view).toEqual({ _tag: "Source" });
  });

  it("shows Pending while the diagram has not rendered yet", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "pending" },
    });
    expect(view).toEqual({ _tag: "Pending" });
  });

  it("shows Diagram with the rendered SVG once the render completes", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "rendered", svg: "<svg>diagram</svg>" },
    });
    expect(view).toEqual({ _tag: "Diagram", svg: "<svg>diagram</svg>" });
  });

  it("shows Failed with the failure message once the render fails", () => {
    const view = resolveMermaidView({
      prefersSource: false,
      renderState: { status: "failed", message: "Parse error on line 1" },
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
    });
    expect(view._tag).not.toBe("Diagram");
  });

  it("shows Source when the user prefers source, even after a failed render", () => {
    const view = resolveMermaidView({
      prefersSource: true,
      renderState: { status: "failed", message: "boom" },
    });
    expect(view).toEqual({ _tag: "Source" });
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
