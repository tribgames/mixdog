/**
 * The virtual pointer the user sees while an agent drives the desktop: one
 * cursor surface per active session, kept in step with the coordinator's
 * snapshot. Sessions that leave the snapshot lose their window; a session
 * whose cursor is hidden keeps its surface warm for the next event.
 */
import { screen } from 'electron';

import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { bindCursorPreparation } from './cursor-readiness';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { type CursorRenderContext, renderCursor } from './cursor-render';
import {
  type CursorSurface,
  cursorBounds,
  dipPoint,
  ensureCursorWindow,
  newCursorSurface,
  stopGlide,
} from './cursor-surface';
import { createCursorTail } from './cursor-tail';
import { computerUseCursorPresentations } from './model';

const POINTER_WATCH_MS = 100;
/** DIP of drift that is still the pointer the agent left behind. */
const POINTER_MOVE_TOLERANCE = 2;

export interface ComputerUseCursorOverlay {
  dispose(): void;
}

export function createComputerUseCursorOverlay(): ComputerUseCursorOverlay {
  const surfaces = new Map<string, CursorSurface>();
  let visibleCursorEvents = new Map<string, number>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  const tail = createCursorTail(() => render());
  const arrivals = new Map<string, { eventId: number; promise: Promise<void> }>();

  const surfaceFor = (sessionId: string): CursorSurface => {
    let surface = surfaces.get(sessionId);
    if (!surface) {
      surface = newCursorSurface();
      surfaces.set(sessionId, surface);
    }
    return surface;
  };

  const presentationBlocked = (): boolean =>
    latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed';

  const renderContext: CursorRenderContext = {
    surfaceFor,
    ownsSurface: (sessionId, surface) => !disposed && surfaces.get(sessionId) === surface,
    showsEvent: (sessionId, eventId) => visibleCursorEvents.get(sessionId) === eventId,
    userControlActive: () => latestSnapshot.userControlActive,
  };

  const destroySurface = (sessionId: string, surface: CursorSurface): void => {
    stopGlide(surface);
    if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
    surfaces.delete(sessionId);
    recordCursorDiagnostic('window_removed');
    arrivals.delete(sessionId);
  };

  // While a foreground session thinks, its arrow stands in for the hidden real
  // pointer. The real pointer moving means the user took the mouse.
  const heldPointers = new Map<string, Electron.Point>();
  let pointerWatch: ReturnType<typeof setInterval> | undefined;
  const watchHeldPointers = (cursors: Array<{ sessionId: string; mode: string }>): void => {
    const phases = new Map(latestSnapshot.activities.map((activity) => [activity.sessionId, activity.phase]));
    const thinking = new Set(
      cursors
        .filter((cursor) => cursor.mode === 'foreground' && phases.get(cursor.sessionId) === 'thinking')
        .map((cursor) => cursor.sessionId)
    );
    for (const sessionId of [...heldPointers.keys()]) if (!thinking.has(sessionId)) heldPointers.delete(sessionId);
    for (const sessionId of thinking) {
      if (!heldPointers.has(sessionId)) heldPointers.set(sessionId, screen.getCursorScreenPoint());
    }
    if (heldPointers.size === 0) {
      if (pointerWatch) clearInterval(pointerWatch);
      pointerWatch = undefined;
      return;
    }
    if (pointerWatch) return;
    pointerWatch = setInterval(() => {
      const point = screen.getCursorScreenPoint();
      for (const [sessionId, held] of [...heldPointers]) {
        if (Math.abs(point.x - held.x) + Math.abs(point.y - held.y) <= POINTER_MOVE_TOLERANCE) continue;
        heldPointers.delete(sessionId);
        computerUseCoordinator.releasePointer(sessionId);
      }
    }, POINTER_WATCH_MS);
    pointerWatch.unref?.();
  };

  /** Bring every surface in step with the snapshot: sessions that left lose
   *  their window, hidden cursors keep a warm surface, new events render. */
  const render = (): void => {
    if (disposed) return;
    const released = new Set(latestSnapshot.releasedPointerSessionIds ?? []);
    const modes = new Map(
      latestSnapshot.activities
        .filter((activity) => !released.has(activity.sessionId))
        .map((activity) => [activity.sessionId, activity.mode])
    );
    const cursors = tail.update(computerUseCursorPresentations(latestSnapshot), presentationBlocked(), modes);
    visibleCursorEvents = new Map(cursors.map((cursor) => [cursor.sessionId, cursor.eventId]));
    watchHeldPointers(cursors);
    const desired = new Set(cursors.map((cursor) => cursor.sessionId));
    if (!presentationBlocked()) {
      for (const activity of latestSnapshot.activities) {
        desired.add(activity.sessionId);
      }
    }
    for (const [sessionId, surface] of surfaces) {
      if (!desired.has(sessionId)) {
        destroySurface(sessionId, surface);
        continue;
      }
      if (!visibleCursorEvents.has(sessionId)) {
        stopGlide(surface);
        if (surface.window && !surface.window.isDestroyed()) surface.window.hide();
      }
    }
    for (const cursor of cursors) {
      if (arrivals.get(cursor.sessionId)?.eventId === cursor.eventId) continue;
      const promise = renderCursor(renderContext, cursor);
      arrivals.set(cursor.sessionId, { eventId: cursor.eventId, promise });
      void promise.catch(() => {
        // No user content or raw Electron error enters the diagnostic.
        if (!disposed && surfaces.has(cursor.sessionId)) {
          console.warn('[computer-cursor] render_failed');
          recordCursorDiagnostic('render_failed');
        }
      });
    }
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    render();
  });
  const unbindPreparation = bindCursorPreparation(async (sessionId) => {
    if (disposed || presentationBlocked()) {
      throw new Error('cursor presentation unavailable');
    }
    if (!latestSnapshot.activities.some((activity) => activity.sessionId === sessionId)) {
      throw new Error('cursor presentation requires an active session');
    }
    const surface = surfaceFor(sessionId);
    await ensureCursorWindow(surface, () => renderContext.ownsSurface(sessionId, surface));
  });
  const reposition = (): void => {
    for (const surface of surfaces.values()) {
      if (!surface.position || !surface.window || surface.window.isDestroyed()) continue;
      stopGlide(surface);
      surface.shown = dipPoint(surface.position);
      surface.window.setBounds(cursorBounds(surface.position), false);
    }
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pointerWatch) clearInterval(pointerWatch);
      heldPointers.clear();
      tail.dispose();
      unsubscribe();
      unbindPreparation();
      screen.removeListener('display-metrics-changed', reposition);
      screen.removeListener('display-added', reposition);
      screen.removeListener('display-removed', reposition);
      for (const surface of surfaces.values()) {
        stopGlide(surface);
        if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      }
      surfaces.clear();
      visibleCursorEvents.clear();
      arrivals.clear();
    },
  };
}
