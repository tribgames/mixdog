/**
 * Target leases: a mutation may only touch windows this session holds. A
 * lease that had to wait is refused even once acquired — the action was
 * planned against a desktop another agent has since changed.
 */
import type { ComputerUseCoordinator } from '../session/coordinator';

export async function claimComputerTargets(
  coordinator: ComputerUseCoordinator,
  sessionId: string,
  windowIds: Array<string | undefined>
): Promise<void> {
  const lease = await coordinator.acquireTargets(sessionId, windowIds);
  if (lease.status === 'acquired') {
    if (lease.queued) {
      throw new Error(
        `computer_target_available_recapture_required: ${lease.windowIds.join(', ')} lease acquired` +
          ` after ${lease.waitedMs}ms; discard the stale action and capture fresh state`
      );
    }
    return;
  }
  if (lease.status === 'user_takeover') {
    throw new Error('computer_user_takeover: queued target request was cancelled because the user took control');
  }
  if (lease.status === 'cancelled') {
    throw new Error('computer_session_aborted: queued target request was cancelled');
  }
  throw new Error(
    `computer_target_in_use: ${lease.windowIds.join(', ')} is reserved by another agent;` +
      ` queue_position=${lease.queuePosition}; retry from a fresh capture`
  );
}
