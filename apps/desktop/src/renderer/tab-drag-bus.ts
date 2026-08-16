// Bridge between the titlebar tab strip and the split-pane workspace: when a
// tab drag leaves the strip band, the strip publishes pointer frames here and
// the workspace turns them into split drop zones.
// A tiny module-level bus keeps the strip and the workspace decoupled — the
// titlebar knows nothing about panes, the workspace nothing about the strip.
import type { WorkspaceSelection } from "./nav-types";

export type TabDragFrame = {
  kind: "tab" | "group" | "session";
  phase: "move" | "drop" | "cancel";
  key: string;
  title: string;
  selection: WorkspaceSelection;
  /** Pane leaf id of the group the drag started in ("" = unknown). */
  sourceLeafId?: string;
  x: number;
  y: number;
  /** Most recent pointer movement; omitted by non-pointer drag sources. */
  deltaX?: number;
  deltaY?: number;
};

const listeners = new Set<(frame: TabDragFrame) => void>();

export function publishTabDrag(frame: TabDragFrame): void {
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      // One consumer fault must not break the drag gesture.
    }
  }
}

export function subscribeTabDrag(listener: (frame: TabDragFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
