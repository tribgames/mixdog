/**
 * intake.mjs — the session object's prompt intake and interruption surface:
 * state access/subscription and the reserved-session handshake here, with
 * submit / submitAsync / submitAndWait, abort (which reclaims an in-flight or
 * still-accepting submission back into the draft) and message rewind composed
 * from ./intake/.
 */
import { createAbortAction } from './intake/abort.mjs';
import { createRewindAction } from './intake/rewind.mjs';
import { createSubmissionIntake } from './intake/submission.mjs';

export function createSessionIntakeApi(bag) {
  const {
    runtime,
    listeners,
    getState,
    getPublishedState = getState,
    set,
    flushEmitImmediate,
    patchItem,
    restoreOlderTranscript,
    restoreNewerTranscript,
    routeState,
    restoreQueued,
    prioritizeQueued,
  } = bag;
  const { acceptingSubmissions, submit, submitAsync, submitAndWait } = createSubmissionIntake(bag);

  return {
    getState: () => getPublishedState(),
    patchItem,
    restoreOlderTranscript,
    restoreNewerTranscript,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit,
    submitAsync,
    submitAndWait,
    reserveSession: (sessionId) => {
      const id = runtime.reserveSessionId?.(sessionId);
      if (!id) return false;
      set({ ...routeState() });
      flushEmitImmediate();
      return String(getState().sessionId || '') === String(id);
    },
    restoreQueued,
    prioritizeQueued,
    ...createRewindAction(bag),
    ...createAbortAction(bag, { acceptingSubmissions }),
  };
}
