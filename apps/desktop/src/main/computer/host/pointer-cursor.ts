/** Publishes a worker's pointer progress as the shared cursor overlay. */
import type { createWorkerPool } from '../backend/worker-pool';
import { type ComputerPresence, legacyPointerProgress } from '../presence/mirror';
import { computerUseCoordinator } from '../session/coordinator';

type PointerProgressListener = NonNullable<Parameters<typeof createWorkerPool>[0]['onPointerProgress']>;

let bound: Pick<ComputerPresence, 'pointerProgress'> | undefined;

/** Routes pointer progress through the presence mirror, which drops it on its own state (a user takeover, a pending
 *  cleanup, a session without activity); until one is bound the in-process coordinator takes it. */
export function bindPointerPresence(presence: Pick<ComputerPresence, 'pointerProgress'>): () => void {
  bound = presence;
  return () => {
    if (bound === presence) bound = undefined;
  };
}

export const publishPointerProgress: PointerProgressListener = (sessionId, x, y, held, mode, phase, windowId) => {
  const event = { x, y, held, mode, phase, windowId };
  if (bound) bound.pointerProgress(sessionId, event);
  else legacyPointerProgress(computerUseCoordinator, sessionId, event);
};
