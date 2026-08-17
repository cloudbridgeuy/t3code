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

  it("de-dupes concurrent calls for the same source and theme into a single parse and render", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();

    // None of these have settled yet — this is the in-flight window that
    // `renderCache` (settled results only) cannot cover on its own, and
    // which a stream of remounts hits before the first render resolves.
    const [first, second, third] = await Promise.all([
      renderMermaidDiagram(source, "light"),
      renderMermaidDiagram(source, "light"),
      renderMermaidDiagram(source, "light"),
    ]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("de-dupes concurrent calls that hit a parse failure into a single parse call", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();
    parse.mockRejectedValueOnce(new Error("bad diagram"));

    const [first, second] = await Promise.all([
      renderMermaidDiagram(source, "light"),
      renderMermaidDiagram(source, "light"),
    ]);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(first).toEqual({ status: "failed", message: "bad diagram" });
    expect(second).toBe(first);
  });

  it("does not retain a render() failure, so a later call retries instead of replaying it", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();
    render.mockRejectedValueOnce(new Error("render exploded"));

    // Two concurrent callers share the one in-flight render, so both see the
    // same rejection...
    const results = await Promise.allSettled([
      renderMermaidDiagram(source, "light"),
      renderMermaidDiagram(source, "light"),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);

    // ...but the failure is not cached anywhere, so a later call for the
    // same source/theme retries rather than replaying the same rejection.
    const retried = await renderMermaidDiagram(source, "light");
    expect(retried).toEqual({ status: "rendered", svg: expect.stringContaining(source) });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("a cache hit renders no second time — getCachedMermaidRender matches renderMermaidDiagram's settled result", async () => {
    const { getCachedMermaidRender, renderMermaidDiagram } = await import("./mermaidRenderer");
    const source = uniqueSource();

    await renderMermaidDiagram(source, "light");
    const cached = getCachedMermaidRender(source, "light");
    const second = await renderMermaidDiagram(source, "light");

    expect(render).toHaveBeenCalledTimes(1);
    expect(cached).toBe(second);
  });
});

describe("mermaidRenderCacheKey", () => {
  it("produces the same key for the same source and theme", async () => {
    const { mermaidRenderCacheKey } = await import("./mermaidRenderer");
    const source = uniqueSource();

    expect(mermaidRenderCacheKey(source, "light")).toBe(mermaidRenderCacheKey(source, "light"));
  });

  it("produces a different key when only the theme changes", async () => {
    const { mermaidRenderCacheKey } = await import("./mermaidRenderer");
    const source = uniqueSource();

    expect(mermaidRenderCacheKey(source, "light")).not.toBe(mermaidRenderCacheKey(source, "dark"));
  });

  it("produces a different key for different sources", async () => {
    const { mermaidRenderCacheKey } = await import("./mermaidRenderer");

    expect(mermaidRenderCacheKey(uniqueSource(), "light")).not.toBe(
      mermaidRenderCacheKey(uniqueSource(), "light"),
    );
  });
});

describe("mermaidSourceKey", () => {
  it("produces the same key regardless of theme, unlike mermaidRenderCacheKey", async () => {
    const { mermaidRenderCacheKey, mermaidSourceKey } = await import("./mermaidRenderer");
    const source = uniqueSource();

    expect(mermaidSourceKey(source)).toBe(mermaidSourceKey(source));
    expect(mermaidRenderCacheKey(source, "light")).not.toBe(mermaidRenderCacheKey(source, "dark"));
  });

  it("produces a different key for different sources", async () => {
    const { mermaidSourceKey } = await import("./mermaidRenderer");

    expect(mermaidSourceKey(uniqueSource())).not.toBe(mermaidSourceKey(uniqueSource()));
  });
});
