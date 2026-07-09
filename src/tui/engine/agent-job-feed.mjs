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
  executionCardKey,
  resolveTuiRuntimeNotificationDelivery,
} from './notification-plan.mjs';
import { readImageAttachmentFromPath } from '../paste-attachments.mjs';
import {
  isDeliveredCompletion,
  recordDeliveredCompletion,
} from '../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';

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

  // FIFO accumulation of model-visible bodies from completions that arrived
  // while busy (or while a pending-resume entry was already queued). A single
  // string slot dropped all-but-the-last body when parallel completions landed;
  // the queue preserves every body and merges them into the resume turn.
  const executionResumeKickBodies = [];

  function kickExecutionPendingResume(body = '') {
    if (body) executionResumeKickBodies.push(body);
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
    // Drain every accumulated body into ONE resume turn so no completion body
    // is lost when several deferred while busy.
    const resumeBody = executionResumeKickBodies.splice(0).filter(Boolean).join('\n\n');
    pending.push(makeQueueEntry(resumeBody, { mode: 'pending-resume', priority: 'next' }));
    void drain();
  }

  function flushDeferredExecutionPendingResumeKick() {
    if (!executionResumeKickDeferred || getDisposed() || getState().busy) return;
    kickExecutionPendingResume();
  }

  function scheduleExecutionPendingResumeKick(body = '') {
    // Carry the model-visible body directly into the pending-resume entry so
    // the resumed turn sends it, instead of relying on the session-pending
    // completion marker (dropped by askSession pre-drain).
    queueMicrotask(() => kickExecutionPendingResume(body));
  }

  // Pure builder for the agent-job card patch. Split out so callers that are
  // already patching the same card in the same tick (see tool-card-results
  // non-aggregate path) can MERGE these fields into their single patchItem
  // instead of issuing a second set() — collapsing the L1/L2 double-update
  // jitter into one visible item update.
  function buildAgentJobCardPatch(itemId, text, isError = false) {
    const parsed = parseAgentJob(text);
    const current = getState().items.find((it) => it.id === itemId);
    const rawDisplayText = agentJobResultText(text, parsed) || String(text ?? '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'agent') : rawDisplayText;
    return {
      result: displayText,
      text: displayText,
      isError,
      errorCount: isError ? 1 : 0,
      ...(parsed ? { args: agentArgsWithResultMetadata(current?.args, parsed) } : {}),
    };
  }

  function updateAgentJobCard(itemId, text, isError = false) {
    patchItem(itemId, buildAgentJobCardPatch(itemId, text, isError));
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
        pushNotice?.(delivery.displayText, delivery.tone || 'info', { transcript: delivery.transcript === true });
        return true;
      }
      if (delivery.action === 'status-only') {
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        return true;
      }
      if (delivery.action === 'execution-ui') {
        const cardKey = executionCardKey(event, text, parsed);
        const firstDelivery = !cardKey || !displayedExecutionNotificationKeys.has(cardKey);
        if (firstDelivery) {
          if (cardKey) displayedExecutionNotificationKeys.add(cardKey);
          pushUserOrSyntheticItem(delivery.displayText, nextId());
        }
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        const resumeBody = String(delivery.modelContent || '').trim();
        if (resumeBody) {
          // Consolidated completion dedup keyed off execution_id (+ text hash):
          // if this exact execution completion was already delivered — either by
          // an earlier TUI enqueue here or by runtime-core's ack — do NOT enqueue
          // a duplicate model-visible twin. A re-arriving completion while IDLE
          // would otherwise re-enqueue and let post-turn drain() spawn a fresh
          // turn. Still ack (modelVisibleDelivered) so runtime-core's
          // mirror/fallback stays suppressed; the card first-delivery push and
          // status refresh above already ran.
          const executionId = event?.meta?.execution_id;
          if (isDeliveredCompletion({ executionId, text: resumeBody })) {
            if (event && typeof event === 'object') event.modelVisibleDelivered = true;
            return true;
          }
          const enqueued = enqueue(resumeBody, {
            mode: 'task-notification',
            // Claude Code parity: live execution completions are queued as
            // task notifications so the active loop can attach them after the
            // next tool batch; no special pending-resume bypass.
            priority: 'next',
            key: notificationKey || undefined,
            displayText: delivery.displayText || text,
            // The immediate Response card was already pushed above
            // (pushUserOrSyntheticItem). Keep this queued twin model-visible
            // but suppress its drain-time transcript card to avoid a duplicate.
            suppressDisplay: true,
          });
          // Self-sufficient TUI dedup: mark delivered right here (mark-once at
          // delivery, keyed by execution_id) so a re-arriving completion is
          // skipped above without depending solely on the runtime-core ack
          // roundtrip — removes the split-brain asymmetry. Gated on a CONFIRMED
          // enqueue: enqueue() returns false only when an identical-key
          // task-notification twin is already queued (session-flow.mjs
          // pendingNotificationKeys.has(key)), in which case the completion is
          // already pending delivery and must not be double-recorded.
          if (enqueued) recordDeliveredCompletion({ executionId, text: resumeBody });
          // EXPLICIT ack to the emitting runtime: the model-visible completion
          // body was injected into the active loop here, so notifyFnForSession
          // must NOT also mirror it into the pending queue (double injection).
          // A bare truthy return below is display/status handling only — this
          // flag is the sole model-visible-delivery signal. Set for BOTH the
          // real-enqueue and the enqueue===false (already-queued twin) cases:
          // either way the completion is pending delivery on the TUI path, so
          // runtime-core must still not mirror it.
          if (event && typeof event === 'object') event.modelVisibleDelivered = true;
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
        // Claude Code parity: task/schedule notifications are lower-priority
        // queue items and drain between turns, behind direct user input.
        priority: 'later',
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
    buildAgentJobCardPatch,
    subscribeRuntimeNotifications,
  };
}
