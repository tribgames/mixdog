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
let settled = false;
let previewActive = false;
let sourceCleanup: (() => void) | null = null;
type PaneDragPoint = { x: number; y: number; target: Element | null };
let lastPoint: PaneDragPoint | null = null;

function paneDragPoint(event: DragEvent): PaneDragPoint | null {
  const x = event.clientX;
  const y = event.clientY;
  // Chromium can emit a synthetic (0, 0) while crossing nested drag targets.
  // It is not a workspace coordinate and must not reverse the split preview.
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
  return {
    x,
    y,
    target: event.target instanceof Element ? event.target : null,
  };
}

function publishPaneDrag(frame: PaneDragFrame): void {
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      // One consumer fault must not break the drag gesture.
    }
  }
}

function resetPaneDrag(): void {
  const cleanup = sourceCleanup;
  activeSession = null;
  settled = false;
  previewActive = false;
  sourceCleanup = null;
  lastPoint = null;
  try {
    cleanup?.();
  } catch {
    // Source UI cleanup must not leak a completed global drag session.
  }
}

export function beginPaneDrag(
  event: DragEvent,
  session: PaneDragSession,
  dragImageContainer: HTMLElement,
  onFinish?: () => void,
): void {
  if (activeSession) finishPaneDrag();
  activeSession = session;
  settled = false;
  previewActive = false;
  sourceCleanup = onFinish ?? null;
  lastPoint = null;
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
  if (!session || settled) return false;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const point = paneDragPoint(event);
  if (!point) return true;
  lastPoint = point;
  previewActive = true;
  publishPaneDrag({
    ...session,
    phase: "move",
    x: point.x,
    y: point.y,
    target: point.target,
  });
  return true;
}

export function dropPaneDrag(event: DragEvent): boolean {
  const session = activeSession;
  if (!session || settled) return false;
  event.preventDefault();
  const point = paneDragPoint(event) ?? lastPoint;
  if (!point) return false;
  settled = true;
  previewActive = false;
  publishPaneDrag({
    ...session,
    phase: "drop",
    x: point.x,
    y: point.y,
    target: point.target,
  });
  resetPaneDrag();
  return true;
}

export function acceptPaneDrag(): boolean {
  if (!activeSession || settled) return false;
  cancelPaneDragPreview();
  settled = true;
  resetPaneDrag();
  return true;
}

export function cancelPaneDragPreview(): void {
  const session = activeSession;
  if (!session || !previewActive) return;
  previewActive = false;
  publishPaneDrag({
    ...session,
    phase: "cancel",
    x: 0,
    y: 0,
    target: null,
  });
}

export function finishPaneDrag(): void {
  if (!settled) cancelPaneDragPreview();
  resetPaneDrag();
}

export function subscribePaneDrag(listener: (frame: PaneDragFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
