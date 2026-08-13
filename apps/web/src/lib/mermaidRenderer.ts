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
    // Strict mode sanitizes mermaid's own SVG output — a real rendered SVG
    // was inspected and confirmed an injected <script> element was stripped
    // outright — which is what makes injecting that output via
    // dangerouslySetInnerHTML safe for untrusted agent-authored diagram
    // text. It does not disable HTML labels: those still render as real
    // HTML (<div>/<p>) inside <foreignObject>.
    securityLevel: "strict",
    theme: mermaidThemeFor(theme),
  });
  initializedTheme = theme;
}

let renderIdCounter = 0;

/** Loads mermaid, initializes it for `theme`, and renders `source` to SVG
 * markup. Invalid diagram text is a normal outcome for agent-authored
 * streaming content, not an exception, so a `parse()` rejection comes back
 * as a `"failed"` value instead of propagating. A genuine loader or render
 * failure (bad chunk, offline, an error `parse()` didn't catch) is a
 * different thing and still throws — callers that need to isolate that from
 * the rest of the page should catch it or wrap the caller in a React error
 * boundary. */
export async function renderMermaidDiagram(
  source: string,
  theme: "light" | "dark",
): Promise<Extract<MermaidRenderState, { status: "rendered" | "failed" }>> {
  const mermaid = await loadMermaidModule();
  ensureInitialized(mermaid, theme);
  try {
    await mermaid.parse(source);
  } catch (error) {
    return { status: "failed", message: mermaidFailureMessage(error) };
  }
  const id = `mermaid-diagram-${renderIdCounter++}`;
  const { svg } = await mermaid.render(id, source);
  return { status: "rendered", svg };
}
