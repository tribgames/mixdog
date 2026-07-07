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
import { readImageAttachmentFromPath } from '../paste-attachments.mjs';

// Channel inbound images arrive as a JSON-array-of-paths meta value (stringified
// across the notify IPC boundary). Parse defensively; a malformed value simply
// yields no images and the notification degrades to its text body.
function parseInboundImagePaths(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

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
  pushNotice,
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
      if (delivery.action === 'notice') {
        pushNotice?.(delivery.displayText, delivery.tone || 'info', { transcript: true });
        return true;
      }
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
      const imagePaths = parseInboundImagePaths(event?.meta?.image_paths);
      if (!modelContent && imagePaths.length === 0) return true;
      const enqueueOpts = {
        mode: 'task-notification',
        priority: 'next',
        key: notificationKey || undefined,
        displayText: delivery.displayText || text,
      };
      if (imagePaths.length > 0) {
        // Read each downloaded image into a real image content block so the
        // channel turn is vision-visible. Async, but the notification is
        // already "handled" (return true) — the enqueue lands on resolve.
        // Any unreadable path is skipped; if none load, fall back to text.
        void (async () => {
          if (getDisposed()) return;
          const parts = [];
          if (modelContent) parts.push({ type: 'text', text: modelContent });
          for (const p of imagePaths) {
            let att = null;
            try { att = await readImageAttachmentFromPath(p); } catch { att = null; }
            if (!att) continue;
            if (att.metadataText) parts.push({ type: 'text', text: att.metadataText });
            parts.push({ type: 'image', data: att.content, mimeType: att.mediaType || 'image/png' });
          }
          if (getDisposed()) return;
          const hasImage = parts.some((part) => part.type === 'image');
          if (!hasImage && !modelContent) return;
          enqueue(hasImage ? parts : modelContent, enqueueOpts);
        })();
        return true;
      }
      enqueue(modelContent, enqueueOpts);
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
