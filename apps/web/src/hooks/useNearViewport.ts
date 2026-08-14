import { useEffect, useState } from "react";

const SCROLL_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

// The chat timeline scrolls inside a LegendList element, not the window, and
// an intermediate scrolling ancestor clips a target's rect before it's
// intersected with the root's — cancelling `rootMargin` unless that ancestor
// is the observer's own root.
function findScrollRoot(node: Element): Element | undefined {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    if (SCROLL_OVERFLOW.has(getComputedStyle(ancestor).overflowY)) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

/**
 * Sticky "has this node ever come near the viewport" signal, expanded by
 * `rootMargin` so a caller can start expensive work slightly before the node
 * is actually visible. Once true, stays true — there is no reason to re-arm
 * an observer for a node that already did its one-time work.
 *
 * Degrades to `true` where `IntersectionObserver` doesn't exist (the test
 * environment has no DOM globals at all): the feature disappears, it does
 * not turn into a permanent "never render". `alreadyNear` lets a caller that
 * remounts this node skip a fresh observer entirely when it already knows
 * the answer from a prior mount.
 */
export function useNearViewport(
  node: Element | null,
  rootMargin: string,
  alreadyNear = false,
): boolean {
  const [nearViewport, setNearViewport] = useState(
    () => alreadyNear || typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (nearViewport || node === null) {
      return;
    }
    const root = findScrollRoot(node);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
        }
      },
      { rootMargin, ...(root !== undefined ? { root } : {}) },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, nearViewport, rootMargin]);

  return nearViewport;
}
