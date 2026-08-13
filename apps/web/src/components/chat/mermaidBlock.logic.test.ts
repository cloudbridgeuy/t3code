import { describe, expect, it } from "vite-plus/test";

import { isMermaidFence, resolveMermaidView } from "./mermaidBlock.logic";

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
});
