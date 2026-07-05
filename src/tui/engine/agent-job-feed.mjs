/**
 * src/tui/engine/agent-job-feed.mjs — agent-job / runtime-notification plumbing
 * extracted from createEngineSession (engine.mjs) as a dependency-injection
 * factory.
 *
 * Owns: the agent-job card result patch (updateAgentJobCard), the
 * execution-pending-resume kick trio (kick / flushDeferred / schedule), and the
 * runtime.onNotification subscription that routes runtime notifications into the
 * store (status refresh, execution-ui synthetic items, model-visible enqueue).
 *
 * These handlers mutate live session state and drive the queue, so
 * state/set/enqueue/drain/pushUserOrSyntheticItem/patchItem/etc are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots. Every body
 * is the original engine.mjs logic verbatim.
 */
import {
  parseAgentJob,
  agentJobResultText,
  agentArgsWithResultMetadata,
} from './agent-envelope.mjs';
import { toolErrorDisplay } from './tool-result-text.mjs';
import {
  notificationQueueKey,
  resolveTuiRuntimeNotificationDelivery,
} from './notification-plan.mjs';

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
  makeQueueEntry,
  getPending,
  agentStatusState,
  displayedExecutionNotificationKeys,
}) {
  let executionResumeKickDeferred = false;

  function kickExecutionPendingResume() {
    if (getDisposed()) return;
    if (getState().busy) {
      executionResumeKickDeferred = true;
      return;
    }
    const pending = getPending();
    if (pending.some((entry) => entry.mode === 'pending-resume')) {
      executionResumeKickDeferred = true;
      return;
    }
    executionResumeKickDeferred = false;
    pending.push(makeQueueEntry('', { mode: 'pending-resume', priority: 'next' }));
    void drain();
  }

  function flushDeferredExecutionPendingResumeKick() {
    if (!executionResumeKickDeferred || getDisposed() || getState().busy) return;
    kickExecutionPendingResume();
  }

  function scheduleExecutionPendingResumeKick() {
    // notifyFnForSession enqueues the model-visible body after onNotification
    // returns; defer the kick so askSession pre-drain sees session pending.
    queueMicrotask(() => kickExecutionPendingResume());
  }

  function updateAgentJobCard(itemId, text, isError = false) {
    const parsed = parseAgentJob(text);
    const current = getState().items.find((it) => it.id === itemId);
    const rawDisplayText = agentJobResultText(text, parsed) || String(text ?? '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'agent') : rawDisplayText;
    patchItem(itemId, {
      result: displayText,
      text: displayText,
      isError,
      errorCount: isError ? 1 : 0,
      ...(parsed ? { args: agentArgsWithResultMetadata(current?.args, parsed) } : {}),
    });
  }

  function subscribeRuntimeNotifications() {
    if (typeof runtime.onNotification !== 'function') return null;
    return runtime.onNotification((event) => {
      if (getDisposed()) return;
      const text = String(event?.content ?? event?.text ?? event ?? '').trim();
      if (!text) return;
      const parsed = parseAgentJob(text);
      const notificationKey = notificationQueueKey(event, text, parsed);
      const delivery = resolveTuiRuntimeNotificationDelivery(event, text);
      if (delivery.action === 'ignore') return;
      if (delivery.action === 'status-only') {
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        return true;
      }
      if (delivery.action === 'execution-ui') {
        const firstDelivery = !notificationKey || !displayedExecutionNotificationKeys.has(notificationKey);
        if (firstDelivery) {
          if (notificationKey) displayedExecutionNotificationKeys.add(notificationKey);
          pushUserOrSyntheticItem(delivery.displayText, nextId());
        }
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        if (String(delivery.modelContent || '').trim()) {
          scheduleExecutionPendingResumeKick();
        }
        return true;
      }
      if (parsed?.taskId) {
        set(agentStatusState({ force: true }));
      }
      const modelContent = String(delivery.modelContent ?? delivery.displayText ?? text).trim();
      if (!modelContent) return true;
      enqueue(modelContent, {
        mode: 'task-notification',
        priority: 'next',
        key: notificationKey || undefined,
        displayText: delivery.displayText || text,
      });
      return true;
    });
  }

  return {
    kickExecutionPendingResume,
    flushDeferredExecutionPendingResumeKick,
    scheduleExecutionPendingResumeKick,
    updateAgentJobCard,
    subscribeRuntimeNotifications,
  };
}
