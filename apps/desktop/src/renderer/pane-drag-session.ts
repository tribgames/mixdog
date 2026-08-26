// One in-process transfer for pane tabs, groups, and sessions. Native browser
// drag events own pointer tracking and edge auto-scroll; this module carries
// application-only metadata and forwards target-local drag lifecycle frames.
import type { WorkspaceSelection } from "./nav-types";

export const PANE_DRAG_MIME = "application/x-mixdog-pane-drag";

export type PaneDragSession = {
  kind: "tab" | "group" | "session";
  key: string;
  title: string;
  selection: WorkspaceSelection;
  /** Pane leaf id of the group the drag started in ("" = unknown). */
  sourceLeafId?: string;
};

export type PaneDragFrame = PaneDragSession & {
  phase: "move" | "drop" | "cancel";
  x: number;
  y: number;
  target: Element | null;
};

const listeners = new Set<(frame: PaneDragFrame) => void>();
let activeSession: PaneDragSession | null = null;
let dropped = false;

function publishPaneDrag(frame: PaneDragFrame): void {
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      // One consumer fault must not break the drag gesture.
    }
  }
}

export function beginPaneDrag(
  event: DragEvent,
  session: PaneDragSession,
  dragImageContainer: HTMLElement,
): void {
  activeSession = session;
  dropped = false;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(PANE_DRAG_MIME, session.key);
  event.dataTransfer.setData("text/plain", session.title);

  const dragImage = document.createElement("div");
  dragImage.className = "workspace-tab-ghost pane-native-drag-image";
  dragImage.textContent = session.title;
  (dragImageContainer.closest(".app-shell") ?? document.body).appendChild(dragImage);
  event.dataTransfer.setDragImage(dragImage, -10, -10);
  window.setTimeout(() => dragImage.remove(), 0);
}

export function currentPaneDrag(): PaneDragSession | null {
  return activeSession;
}

export function movePaneDrag(event: DragEvent): boolean {
  const session = activeSession;
  if (!session) return false;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  publishPaneDrag({
    ...session,
    phase: "move",
    x: event.clientX,
    y: event.clientY,
    target: event.target instanceof Element ? event.target : null,
  });
  return true;
}

export function dropPaneDrag(event: DragEvent): boolean {
  const session = activeSession;
  if (!session) return false;
  event.preventDefault();
  dropped = true;
  publishPaneDrag({
    ...session,
    phase: "drop",
    x: event.clientX,
    y: event.clientY,
    target: event.target instanceof Element ? event.target : null,
  });
  return true;
}

export function acceptPaneDrag(): boolean {
  if (!activeSession) return false;
  dropped = true;
  return true;
}

export function leavePaneDrag(): void {
  const session = activeSession;
  if (!session) return;
  publishPaneDrag({ ...session, phase: "cancel", x: 0, y: 0, target: null });
}

export function finishPaneDrag(): void {
  const session = activeSession;
  if (session && !dropped) {
    publishPaneDrag({ ...session, phase: "cancel", x: 0, y: 0, target: null });
  }
  activeSession = null;
  dropped = false;
}

export function subscribePaneDrag(listener: (frame: PaneDragFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
