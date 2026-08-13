import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { initialize, parse, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn().mockResolvedValue(true),
  render: vi.fn(async (id: string, source: string) => ({ svg: `<svg id="${id}">${source}</svg>` })),
}));

vi.mock("mermaid", () => ({
  default: { initialize, parse, render },
}));

// `renderMermaidDiagram` caches by (source, theme) at module scope, so tests
// share that cache with each other unless every source string used here is
// unique — hence the per-test `uniqueSource` helper below instead of a
// literal like "graph TD".
let sourceCounter = 0;
function uniqueSource(): string {
  sourceCounter += 1;
  return `graph TD\nA-->B${sourceCounter}`;
}

describe("renderMermaidDiagram caching", () => {
  beforeEach(() => {
    initialize.mockClear();
    parse.mockClear();
    render.mockClear();
  });

  it("renders once and reuses the result for a repeat call with the same source and theme", async () => {
    const { getCachedMermaidRender, renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();

    const first = await renderMermaidDiagram(source, "light");
    const second = await renderMermaidDiagram(source, "light");

    expect(render).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: "rendered", svg: expect.stringContaining(source) });
    // Same object reference — this is what lets a consuming component's
    // setState bail out via Object.is instead of triggering a re-render.
    expect(second).toBe(first);
    expect(getCachedMermaidRender(source, "light")).toBe(first);
  });

  it("renders separately per theme even for the same source", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();

    const light = await renderMermaidDiagram(source, "light");
    const dark = await renderMermaidDiagram(source, "dark");

    expect(render).toHaveBeenCalledTimes(2);
    expect(light).not.toBe(dark);
  });

  it("caches a parse failure too, without calling parse again", async () => {
    const { getCachedMermaidRender, renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();
    parse.mockRejectedValueOnce(new Error("bad diagram"));

    const first = await renderMermaidDiagram(source, "light");
    const second = await renderMermaidDiagram(source, "light");

    expect(parse).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(first).toEqual({ status: "failed", message: "bad diagram" });
    expect(second).toBe(first);
    expect(getCachedMermaidRender(source, "light")).toBe(first);
  });

  it("has no cached entry before the first render", async () => {
    const { getCachedMermaidRender } = await import("./mermaidRenderer");
    const source = uniqueSource();

    expect(getCachedMermaidRender(source, "light")).toBeUndefined();
  });
});
