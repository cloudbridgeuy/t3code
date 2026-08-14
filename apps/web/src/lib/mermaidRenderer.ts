import type { Mermaid } from "mermaid";

import {
  mermaidFailureMessage,
  type MermaidRenderState,
} from "../components/chat/mermaidBlock.logic";

/**
 * Mermaid bundles its own layout engines and is large, so it is fetched at
 * most once, lazily, on the first diagram — mirroring the highlighter cache
 * in `syntaxHighlighting.ts`. A rejected import (network blip, bad chunk) is
 * evicted rather than cached, so the next attempt retries the import instead
 * of replaying the same failure forever.
 */
let mermaidModulePromise: Promise<Mermaid> | null = null;

function loadMermaidModule(): Promise<Mermaid> {
  if (mermaidModulePromise) {
    return mermaidModulePromise;
  }
  const promise = import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidModulePromise = null;
      throw error;
    });
  mermaidModulePromise = promise;
  return promise;
}

function mermaidThemeFor(theme: "light" | "dark"): "default" | "dark" {
  return theme === "dark" ? "dark" : "default";
}

// `initialize` is a blocking, global config call — re-running it on every
// render would be wasted work, so it only re-runs when the resolved theme
// actually changes.
let initializedTheme: "light" | "dark" | null = null;

function ensureInitialized(mermaid: Mermaid, theme: "light" | "dark"): void {
  if (initializedTheme === theme) {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    // Strict mode sanitizes mermaid's own SVG output — verified by
    // inspecting a rendered SVG from malicious input, whose injected
    // <script> was stripped outright. That sanitization, not HTML labels
    // (still enabled; they render inside <foreignObject>), is what makes
    // injecting the result via dangerouslySetInnerHTML safe for untrusted
    // diagram text.
    securityLevel: "strict",
    theme: mermaidThemeFor(theme),
  });
  initializedTheme = theme;
}

let renderIdCounter = 0;

type MermaidRenderResult = Extract<MermaidRenderState, { status: "rendered" | "failed" }>;

/**
 * Memoizes `renderMermaidDiagram` by source and theme, since `render()` is a
 * pure function of both.
 *
 * This exists because `ChatMarkdown`'s `markdownComponents` memo depends on
 * the full message `text`, which grows with every streamed token: that gives
 * the `pre` override a new identity per token, and React remounts
 * `MermaidBlock` on every remaining token once its fence has closed. Without
 * this cache, every one of those remounts would redo a full parse+render;
 * `getCachedMermaidRender` lets `MermaidBlock` seed its state from an
 * already-known result instead of flashing back to pending.
 *
 * Unbounded by design; a bounded LRU is meant to replace it later, so keep
 * this simple enough to delete outright when that lands.
 */
const renderCache = new Map<string, MermaidRenderResult>();

function mermaidRenderCacheKey(source: string, theme: "light" | "dark"): string {
  return `${theme}\0${source}`;
}

/** Synchronous cache lookup, for seeding a component's initial render state
 * without waiting on the async `renderMermaidDiagram` path. */
export function getCachedMermaidRender(
  source: string,
  theme: "light" | "dark",
): MermaidRenderResult | undefined {
  return renderCache.get(mermaidRenderCacheKey(source, theme));
}

/**
 * `renderCache` only helps once a render has settled, not during the window
 * a first render for a given `(source, theme)` is still in flight — and that
 * window is not short, since it awaits `loadMermaidModule()`'s ~670 kB
 * import. Every token that streams in during that window remounts
 * `MermaidBlock`, missing `renderCache` and calling `renderMermaidDiagram`
 * again; without this map, that would mean dozens of concurrent parse+render
 * calls for the same input.
 *
 * Keyed the same way as `renderCache` and always evicted once the promise
 * settles: on success the result already lives in `renderCache`, and on
 * rejection (loader failure or a `render()` throw) evicting is what keeps
 * the failure retryable instead of replaying it forever.
 */
const inFlightRenders = new Map<string, Promise<MermaidRenderResult>>();

async function renderMermaidDiagramUncached(
  key: string,
  source: string,
  theme: "light" | "dark",
): Promise<MermaidRenderResult> {
  const mermaid = await loadMermaidModule();
  ensureInitialized(mermaid, theme);
  try {
    await mermaid.parse(source);
  } catch (error) {
    const result: MermaidRenderResult = { status: "failed", message: mermaidFailureMessage(error) };
    renderCache.set(key, result);
    return result;
  }
  const id = `mermaid-diagram-${renderIdCounter++}`;
  const { svg } = await mermaid.render(id, source);
  const result: MermaidRenderResult = { status: "rendered", svg };
  renderCache.set(key, result);
  return result;
}

/** Loads mermaid, initializes it for `theme`, and renders `source` to SVG
 * markup. Invalid diagram text is a normal outcome for agent-authored
 * streaming content, not an exception, so a `parse()` rejection comes back
 * as a `"failed"` value instead of propagating. A genuine loader or render
 * failure (bad chunk, offline, an error `parse()` didn't catch) is a
 * different thing and still throws — callers that need to isolate that from
 * the rest of the page should catch it or wrap the caller in a React error
 * boundary.
 *
 * Repeat calls for the same `source`/`theme` return the cached result
 * (including a cached failure) without re-parsing or re-rendering, and
 * concurrent calls before the first one has settled share the same in-flight
 * render instead of each starting their own — see `inFlightRenders` above. */
export function renderMermaidDiagram(
  source: string,
  theme: "light" | "dark",
): Promise<MermaidRenderResult> {
  const key = mermaidRenderCacheKey(source, theme);
  const cached = renderCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const inFlight = inFlightRenders.get(key);
  if (inFlight) {
    return inFlight;
  }
  const promise = renderMermaidDiagramUncached(key, source, theme).finally(() => {
    inFlightRenders.delete(key);
  });
  inFlightRenders.set(key, promise);
  return promise;
}
