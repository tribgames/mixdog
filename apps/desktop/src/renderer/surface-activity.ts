// One bounded lifecycle signal for retained (mounted-but-inactive) surfaces.
// The Dock keeps every visited tab mounted, so anything that escapes its pane
// — a body portal, a background fetch — has to learn that its owner is no
// longer the presented surface. Context (not a document-wide heuristic) keeps
// the signal scoped to the exact React subtree that owns the portal, and it
// travels through createPortal because portals inherit the React tree.
import { createContext, useContext } from "react";

/** True outside a retained-surface owner: standalone mounts stay active. */
export const SurfaceActiveContext = createContext(true);

export function useSurfaceActive(): boolean {
  return useContext(SurfaceActiveContext);
}
