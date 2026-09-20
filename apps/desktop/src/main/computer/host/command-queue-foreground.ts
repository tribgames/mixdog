/**
 * The one foreground lane: the desktop has a single keyboard and pointer, so
 * foreground deliveries from every session run one at a time. A request that
 * had to wait behind another sees a desktop that may have changed, so by
 * default it is refused with a recapture demand rather than run blind.
 */
import { type ComputerUseCoordinator, queuedForegroundRequiresRecapture } from '../session/coordinator';

/** The lane was entered while the user held the desktop; the caller parks. */
export class PausedBeforeDispatch extends Error {}

export interface ForegroundLaneSettings {
  requireFreshAfterWait?: boolean;
  assertRunnable?: () => void;
  allowWhileUserControl?: boolean;
}

export function createForegroundLane(coordinator: ComputerUseCoordinator) {
  let foregroundChain: Promise<unknown> = Promise.resolve();
  let foregroundQueueDepth = 0;

  function runForegroundExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
    settings: ForegroundLaneSettings = {}
  ): Promise<T> {
    const queuePosition = foregroundQueueDepth++;
    if (queuePosition > 0) coordinator.queueForeground(sessionId, queuePosition);
    const run = foregroundChain.then(async () => {
      try {
        settings.assertRunnable?.();
        if (!settings.allowWhileUserControl) {
          if (coordinator.snapshot().userControlActive) throw new PausedBeforeDispatch();
          coordinator.assertAutomationAllowed();
        }
        coordinator.activateForeground(sessionId);
        if (settings.requireFreshAfterWait !== false && queuedForegroundRequiresRecapture(queuePosition)) {
          throw new Error(
            'computer_foreground_available_recapture_required: desktop lane changed; capture fresh state'
          );
        }
        return await operation();
      } finally {
        foregroundQueueDepth = Math.max(0, foregroundQueueDepth - 1);
      }
    });
    foregroundChain = run.catch(() => undefined);
    return run;
  }

  return { runForegroundExclusive };
}

export type ForegroundLane = ReturnType<typeof createForegroundLane>;
