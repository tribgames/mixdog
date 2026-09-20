/**
 * src/tui/session/agent-job-feed.mjs — agent-job / runtime-notification plumbing
 * for the session runtime, as a dependency-injection factory.
 *
 * Owns: the agent-job card result patch (updateAgentJobCard), the
 * execution-pending-resume kick trio (kick / flushDeferred / schedule), and the
 * runtime.onNotification subscription that routes runtime notifications into the
 * store. The phases live under agent-job-feed/.
 *
 * These handlers mutate live session state and drive the queue, so
 * state/set/enqueue/drain/pushUserOrSyntheticItem/patchItem/etc are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots.
 */
import { createNotificationEnqueueChain } from './agent-job-feed/notification-chain.mjs';
import { createExecutionDedup } from './agent-job-feed/execution-dedup.mjs';
import { createPendingResume } from './agent-job-feed/pending-resume.mjs';
import { createAgentJobCard } from './agent-job-feed/agent-job-card.mjs';
import { createAgentStatusRefresh } from './agent-job-feed/agent-status-refresh.mjs';
import { createExecutionDelivery } from './agent-job-feed/execution-delivery.mjs';
import { createModelNotificationEnqueue } from './agent-job-feed/model-notification.mjs';
import { createNotificationRouter } from './agent-job-feed/notification-router.mjs';

export function createAgentJobFeed({
  runtime,
  getState,
  set,
  nextId,
  getDisposed,
  patchItem,
  enqueue,
  drain,
  pushUserOrSyntheticItem,
  pushAsyncAgentResponse,
  makeQueueEntry,
  getPending,
  agentStatusState,
  displayedExecutionNotificationKeys,
  itemIndexById,
  pushNotice,
  now = () => Date.now(),
  executionResumeTombstoneTtlMs = 30_000,
  executionResumeTombstoneLimit = 128,
}) {
  const dedup = createExecutionDedup({ displayedNotificationKeys: displayedExecutionNotificationKeys });
  const pendingResume = createPendingResume({
    getState,
    getDisposed,
    drain,
    makeQueueEntry,
    getPending,
    now,
    tombstoneTtlMs: executionResumeTombstoneTtlMs,
    tombstoneLimit: executionResumeTombstoneLimit,
  });
  const card = createAgentJobCard({ getState, itemIndexById, patchItem });
  const statusRefresh = createAgentStatusRefresh({ set, getDisposed, agentStatusState });
  const executionDelivery = createExecutionDelivery({
    dedup,
    pendingResume,
    enqueue,
    nextId,
    pushResponse: pushAsyncAgentResponse || pushUserOrSyntheticItem,
    statusRefresh,
  });
  const modelNotification = createModelNotificationEnqueue({
    chain: createNotificationEnqueueChain({ pushNotice }),
    enqueue,
    getState,
    getDisposed,
  });
  const routeNotification = createNotificationRouter({
    set,
    pushNotice,
    getDisposed,
    dedup,
    statusRefresh,
    executionDelivery,
    modelNotification,
  });

  function subscribeRuntimeNotifications() {
    if (typeof runtime.onNotification !== 'function') return null;
    const unsubscribe = runtime.onNotification(routeNotification);
    return () => {
      try {
        unsubscribe?.();
      } finally {
        statusRefresh.dispose();
        dedup.clear();
      }
    };
  }

  return {
    kickExecutionPendingResume: pendingResume.kick,
    flushDeferredExecutionPendingResumeKick: pendingResume.flushDeferred,
    scheduleExecutionPendingResumeKick: pendingResume.schedule,
    discardExecutionPendingResume: pendingResume.discard,
    updateAgentJobCard: card.updateAgentJobCard,
    buildAgentJobCardPatch: card.buildAgentJobCardPatch,
    subscribeRuntimeNotifications,
    clearExecutionDedupState: dedup.clear,
  };
}
