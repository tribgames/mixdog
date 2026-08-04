// Runtime notification fan-out. A notification reaches listeners (TUI/API) and,
// for terminal tool completions, may also be mirrored into the session's
// pending queue so the model sees it next turn. The delivered registry keeps
// those two paths from double-injecting the same completion.
import { modelVisibleToolCompletionMessage } from '../runtime/shared/tool-execution-contract.mjs';
import { markCompletionEntry } from '../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import {
  isDeliveredCompletion,
  logDuplicateSkip,
  recordDeliveredCompletion,
} from '../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { shouldMirrorCompletionToPendingQueue } from './runtime-tool-routing.mjs';

export function createNotificationBus({ listeners, mgr }) {
  function emitRuntimeNotification(content, meta = {}) {
    const text = String(content || '').trim();
    if (!text) return { handled: false, modelVisibleDelivered: false };
    const event = { content: text, meta: meta && typeof meta === 'object' ? meta : {} };
    let handled = false;
    for (const listener of [...listeners]) {
      try {
        if (listener(event) === true) handled = true;
      } catch { /* a broken listener never blocks the rest */ }
    }
    // EXPLICIT model-visible ack: only the TUI execution-ui path sets
    // event.modelVisibleDelivered when it enqueues the body into the active
    // loop. A display-only listener returning true is NOT that ack.
    return { handled, modelVisibleDelivered: event.modelVisibleDelivered === true };
  }

  // Enqueue the model-visible twin unless it was already delivered; returns
  // true when the caller may treat the completion as delivered.
  function enqueueCompletion(callerSessionId, text, meta, path) {
    const visible = modelVisibleToolCompletionMessage(text, meta);
    // Non-completion notifications yield '' here and are never queued.
    if (!visible) return false;
    if (isDeliveredCompletion({ executionId: meta?.execution_id, text: visible })) {
      // Delivered + ACKed on the TUI path: suppress the duplicate but report
      // DELIVERED so the caller stops retrying.
      logDuplicateSkip(path, { executionId: meta?.execution_id, text: visible });
      return true;
    }
    return mgr.enqueuePendingMessage(callerSessionId, markCompletionEntry(visible)) > 0;
  }

  function notifyFnForSession(callerSessionId) {
    return (text, meta = {}) => {
      const { handled, modelVisibleDelivered } = emitRuntimeNotification(text, meta);
      let enqueued = false;
      // Record the TUI delivery so a racing enqueue in THIS process (background
      // reconcile / fallback / notify) skips instead of double-injecting.
      if (modelVisibleDelivered) {
        try {
          recordDeliveredCompletion({
            executionId: meta?.execution_id,
            text: modelVisibleToolCompletionMessage(text, meta),
          });
        } catch { /* registry is best-effort */ }
      }
      // TUI sessions consume raw envelopes for UI cards, but those are
      // internal-only in pending drain: mirror the model-visible twin unless the
      // TUI explicitly acked it.
      if (shouldMirrorCompletionToPendingQueue({
        callerSessionId,
        modelVisibleDelivered,
        hasEnqueue: typeof mgr.enqueuePendingMessage === 'function',
        text,
        meta,
      })) {
        try { enqueued = enqueueCompletion(callerSessionId, text, meta, 'mirror'); } catch { /* best-effort */ }
      }
      // Headless/API listeners may exist without consuming the event: keep the
      // fallback enqueue for an otherwise unhandled completion.
      if (!enqueued && !handled && callerSessionId && typeof mgr.enqueuePendingMessage === 'function') {
        try { enqueued = enqueueCompletion(callerSessionId, text, meta, 'fallback'); } catch { /* best-effort */ }
      }
      return enqueued || handled;
    };
  }

  return { emitRuntimeNotification, notifyFnForSession };
}
