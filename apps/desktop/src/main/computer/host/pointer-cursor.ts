/** Publishes a worker's pointer progress as the shared cursor overlay. */
import type { createWorkerPool } from '../backend/worker-pool';
import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import { computerUseCoordinator, type ComputerUseCursorEffect } from '../session/coordinator';

type PointerProgressListener = NonNullable<Parameters<typeof createWorkerPool>[0]['onPointerProgress']>;

/** The cursor effect each pointer-progress phase paints; a bare move
 *  depends on whether a button is held. */
const PHASE_CURSOR_EFFECTS: Record<string, ComputerUseCursorEffect> = {
  release: 'click',
  prepare: 'prepare',
  press: 'press',
  scroll: 'scroll',
  type: 'type',
};

/** Paints only while the session is actively driving the desktop: a user
 *  takeover, pending cleanup, or a session without activity drops the update. */
export const publishPointerProgress: PointerProgressListener = (sessionId, x, y, held, mode, phase, windowId) => {
  const state = computerUseCoordinator.snapshot();
  if (state.userControlActive) {
    recordCursorDiagnostic('ignored_user_control');
    return;
  }
  if (state.cleanupState !== 'ready') {
    recordCursorDiagnostic('ignored_cleanup');
    return;
  }
  if (!state.activities.some((activity) => activity.sessionId === sessionId)) {
    recordCursorDiagnostic('ignored_no_activity');
    return;
  }
  recordCursorDiagnostic('published');
  computerUseCoordinator.showCursor({
    sessionId,
    windowId,
    x,
    y,
    tracking: true,
    action: phase,
    effect: PHASE_CURSOR_EFFECTS[phase] ?? (held ? 'drag' : 'move'),
    mode,
  });
};
