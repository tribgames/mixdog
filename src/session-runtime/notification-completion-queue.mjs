// The model-visible queue path of a terminal tool completion
// (notification-bus.mjs): enqueue its twin once, skipping a completion the TUI
// path already delivered or this bus already queued.
import { modelVisibleToolCompletionMessage } from '../runtime/shared/tool-execution-contract.mjs';
import { markCompletionEntry } from '../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import {
  isDeliveredCompletion,
  logDuplicateSkip,
} from '../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';

// Bounded memory of `${session}:${entry id}` keys this bus queued.
const QUEUED_COMPLETION_IDS_MAX = 512;

export function createCompletionQueue({ mgr, onCompletionQueued }) {
  const queuedCompletionIds = new Map();

  // Enqueue the model-visible twin unless it was already delivered; returns
  // true when the caller may treat the completion as delivered.
  return function enqueueCompletion(callerSessionId, text, meta, path) {
    const visible = modelVisibleToolCompletionMessage(text, meta);
    // Non-completion notifications yield '' here and are never queued.
    if (!visible) return false;
    if (isDeliveredCompletion({ executionId: meta?.execution_id, text: visible })) {
      // Delivered + ACKed on the TUI path: suppress the duplicate but report
      // DELIVERED so the caller stops retrying.
      logDuplicateSkip(path, { executionId: meta?.execution_id, text: visible });
      return true;
    }
    const entry = markCompletionEntry(visible, { executionId: meta?.execution_id, meta });
    const queueKey = `${callerSessionId}:${entry.id}`;
    if (queuedCompletionIds.has(queueKey)) {
      logDuplicateSkip(`${path}-queued`, { executionId: meta?.execution_id, text: visible });
      return true;
    }
    const enqueued = mgr.enqueuePendingMessage(callerSessionId, entry) > 0;
    if (!enqueued) return false;
    queuedCompletionIds.set(queueKey, Date.now());
    while (queuedCompletionIds.size > QUEUED_COMPLETION_IDS_MAX) {
      queuedCompletionIds.delete(queuedCompletionIds.keys().next().value);
    }
    if (typeof onCompletionQueued === 'function') {
      try {
        onCompletionQueued({
          sessionId: callerSessionId,
          executionId: meta?.execution_id || null,
          enqueuedAt: entry.enqueuedAt,
        });
      } catch {
        /* wake-up is best-effort; the durable queue remains authoritative */
      }
    }
    return true;
  };
}
