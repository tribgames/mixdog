// Owner/worker completion-notification helpers, a factory so the mgr-bound
// closures stay per agent instance; deps are injected.
import { modelVisibleToolCompletionMessage } from '../../../runtime/shared/tool-execution-contract.mjs';
import { markCompletionEntry } from '../../../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import {
  isDeliveredCompletion,
  logDuplicateSkip,
} from '../../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { clean } from './helpers.mjs';
import { createEarlyCompletionNotice } from './notify/early-completion.mjs';

export function createNotify(mgr, { notifySessionCompletion, onWorkerCompletionQueued = null } = {}) {
  function enqueueCompletionMessage(sessionId, text, meta = {}) {
    const target = clean(sessionId);
    if (!target || typeof mgr.enqueuePendingMessage !== 'function') return false;
    try {
      const visible = modelVisibleToolCompletionMessage(text, meta);
      if (!visible) return false;
      // Skip-if-delivered: the TUI already injected + ACKed this completion
      // body into the active loop, so this racing enqueue (fallback/reconcile
      // or the async reject/false-resolve rescue) would double-inject it.
      // Report DELIVERED (truthy), not false — a false return propagates through
      // tryEnqueueFallback→onSettled(false), which un-marks notified/
      // notifiedWithBody (background-tasks.mjs) and makes reconcile refire
      // forever, eventually enqueuing a post-eviction duplicate. Suppressed here
      // == already delivered, so the caller must mark it notified and stop.
      if (isDeliveredCompletion({ executionId: meta?.execution_id, text: visible })) {
        logDuplicateSkip('notify-enqueue', { executionId: meta?.execution_id, text: visible });
        return true;
      }
      // Mark this as a completion/task notification: delivery dedupes it by
      // execution id, and it stays queued (durably) until the model gets it.
      return Boolean(
        mgr.enqueuePendingMessage(
          target,
          markCompletionEntry(visible, {
            executionId: meta?.execution_id,
            meta,
          })
        ) > 0
      );
    } catch {
      return false;
    }
  }

  function notifyOwner(ownerSessionId, text, meta = {}) {
    const owner = clean(ownerSessionId);
    if (!owner || typeof notifySessionCompletion !== 'function') return false;
    const ownerMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      caller_session_id: owner,
    };
    delete ownerMeta.routing_session_id;
    try {
      return notifySessionCompletion(owner, text, ownerMeta) !== false;
    } catch {
      return false;
    }
  }

  function workerNotifyFn(workerSessionId) {
    const workerId = clean(workerSessionId);
    return (text, meta = {}) => {
      // Tool completions produced inside a Subagent belong to that Subagent's
      // session. Mirroring them to the owner made every promoted shell command
      // appear as a second Lead-level completion card. Agent task completion
      // has its own owner delivery path below; only that terminal handoff
      // crosses the parent boundary.
      if (!workerId) return false;
      const queued = enqueueCompletionMessage(workerId, text, meta);
      // A busy worker takes the completion at its next tool boundary; an idle
      // one is woken so the result reaches it now, not at its next message.
      if (queued && typeof onWorkerCompletionQueued === 'function') {
        setImmediate(() => {
          try {
            onWorkerCompletionQueued(workerId);
          } catch {}
        });
      }
      return queued;
    };
  }

  return {
    enqueueCompletionMessage,
    workerNotifyFn,
    notifyOwnerAgentCompletionEarly: createEarlyCompletionNotice({ notifyOwner }),
  };
}
