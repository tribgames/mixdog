// One bounded lifecycle signal for retained (mounted-but-inactive) surfaces.
// The Dock keeps every visited tab mounted, so anything that escapes its pane
// — a body portal, a background fetch — has to learn that its owner is no
// longer the presented surface. Context (not a document-wide heuristic) keeps
// the signal scoped to the exact React subtree that owns the portal, and it
// travels through createPortal because portals inherit the React tree.
import { createContext, useContext, useLayoutEffect, useRef } from "react";

/** True outside a retained-surface owner: standalone mounts stay active. */
export const SurfaceActiveContext = createContext(true);

export function useSurfaceActive(): boolean {
  return useContext(SurfaceActiveContext);
}

/** Reset only navigation owned by a surface that was actually closed.
 * Hidden prewarming and unrelated pane updates must not overwrite deep links
 * or drafts. The caller keeps data, operations and editor content separate. */
export function useSurfaceNavigationReset(active: boolean, reset: () => void): void {
  const wasActive = useRef(active);
  const latest = useRef(reset);
  latest.current = reset;
  useLayoutEffect(() => {
    const closed = wasActive.current && !active;
    wasActive.current = active;
    if (closed) latest.current();
  }, [active]);
}
