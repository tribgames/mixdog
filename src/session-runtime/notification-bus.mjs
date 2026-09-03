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
import { notifyTrace } from '../runtime/shared/notify-trace.mjs';

const sessionNotificationListeners = new Map();

function cleanSessionId(value) {
  return String(value || '').trim();
}

function emitToListeners(source, content, meta = {}) {
  const text = String(content || '').trim();
  if (!text) return { handled: false, modelVisibleDelivered: false };
  const event = { content: text, meta: meta && typeof meta === 'object' ? meta : {} };
  let handled = false;
  for (const listener of [...source]) {
    try {
      if (listener(event) === true) handled = true;
    } catch { /* a broken listener never blocks the rest */ }
  }
  return { handled, modelVisibleDelivered: event.modelVisibleDelivered === true };
}

export function createNotificationBus({ listeners, mgr, onCompletionQueued }) {
  const boundSessionListeners = new Map();
  const queuedCompletionIds = new Map();

  function emitRuntimeNotification(content, meta = {}) {
    return emitToListeners(listeners, content, meta);
  }

  function notifySession(sessionId, content, meta = {}) {
    const targetSessionId = cleanSessionId(sessionId);
    if (!targetSessionId) return false;
    const targetListeners = sessionNotificationListeners.get(targetSessionId) || [];
    const { handled } = emitToListeners(targetListeners, content, meta);
    if (handled) return true;
    if (typeof mgr.enqueuePendingMessage !== 'function') return false;
    try { return mgr.enqueuePendingMessage(targetSessionId, content) > 0; }
    catch { return false; }
  }

  // UI-only delivery: reaches the session's attached surfaces (TUI/Desktop
  // store) and reports whether one handled it. Never enqueues into the model
  // queue — a headless session simply gets `false` so the caller can fall back
  // to text guidance instead of injecting a UI instruction into the transcript.
  function notifySessionUi(sessionId, content, meta = {}) {
    const targetSessionId = cleanSessionId(sessionId);
    if (!targetSessionId) return false;
    const targetListeners = sessionNotificationListeners.get(targetSessionId) || [];
    return emitToListeners(targetListeners, content, meta).handled;
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
    const entry = markCompletionEntry(visible, { executionId: meta?.execution_id, meta });
    const queueKey = `${callerSessionId}:${entry.id}`;
    if (queuedCompletionIds.has(queueKey)) {
      logDuplicateSkip(`${path}-queued`, { executionId: meta?.execution_id, text: visible });
      return true;
    }
    const enqueued = mgr.enqueuePendingMessage(callerSessionId, entry) > 0;
    if (!enqueued) return false;
    queuedCompletionIds.set(queueKey, Date.now());
    while (queuedCompletionIds.size > 512) queuedCompletionIds.delete(queuedCompletionIds.keys().next().value);
    if (typeof onCompletionQueued === 'function') {
      try {
        onCompletionQueued({
          sessionId: callerSessionId,
          executionId: meta?.execution_id || null,
          enqueuedAt: entry.enqueuedAt,
        });
      } catch { /* wake-up is best-effort; the durable queue remains authoritative */ }
    }
    return true;
  }

  function notifySessionCompletion(sessionId, text, meta = {}) {
    const targetSessionId = cleanSessionId(sessionId);
    if (!targetSessionId) return false;
    const targetListeners = sessionNotificationListeners.get(targetSessionId) || [];
    const ownerMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      caller_session_id: targetSessionId,
    };
    delete ownerMeta.routing_session_id;
    const { handled, modelVisibleDelivered } = emitToListeners(targetListeners, text, ownerMeta);
    notifyTrace('bus:completion', {
      session: targetSessionId,
      exec: meta?.execution_id,
      status: meta?.status,
      textLen: String(text || '').length,
      listeners: targetListeners.length ?? targetListeners.size,
      handled,
      mvd: modelVisibleDelivered,
    });
    if (modelVisibleDelivered) {
      try {
        recordDeliveredCompletion({
          executionId: meta?.execution_id,
          text: modelVisibleToolCompletionMessage(text, ownerMeta),
        });
      } catch { /* registry is best-effort */ }
    }
    const mustQueue = !handled || shouldMirrorCompletionToPendingQueue({
      callerSessionId: targetSessionId,
      modelVisibleDelivered,
      hasEnqueue: typeof mgr.enqueuePendingMessage === 'function',
      text,
      meta: ownerMeta,
    });
    let enqueued = false;
    if (mustQueue && typeof mgr.enqueuePendingMessage === 'function') {
      try { enqueued = enqueueCompletion(targetSessionId, text, ownerMeta, 'owner'); } catch { /* best-effort */ }
    }
    return enqueued || handled;
  }

  function notifyFnForSession(callerSessionId) {
    const ownerSessionId = cleanSessionId(callerSessionId);
    return (text, meta = {}) => notifySessionCompletion(ownerSessionId, text, meta);
  }

  function bindListenerToSession(sessionId, listener) {
    const ownerSessionId = cleanSessionId(sessionId);
    if (!ownerSessionId || typeof listener !== 'function') return;
    let bucket = sessionNotificationListeners.get(ownerSessionId);
    if (!bucket) {
      bucket = new Set();
      sessionNotificationListeners.set(ownerSessionId, bucket);
    }
    bucket.add(listener);
    let ownedBucket = boundSessionListeners.get(ownerSessionId);
    if (!ownedBucket) {
      ownedBucket = new Set();
      boundSessionListeners.set(ownerSessionId, ownedBucket);
    }
    ownedBucket.add(listener);
  }

  function unbindListener(listener) {
    for (const [sessionId, ownedBucket] of boundSessionListeners) {
      if (!ownedBucket.delete(listener)) continue;
      const bucket = sessionNotificationListeners.get(sessionId);
      bucket?.delete(listener);
      if (bucket?.size === 0) sessionNotificationListeners.delete(sessionId);
      if (ownedBucket.size === 0) boundSessionListeners.delete(sessionId);
    }
  }

  function subscribeRuntimeNotification(sessionId, listener) {
    const ownerSessionId = cleanSessionId(sessionId);
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    bindListenerToSession(ownerSessionId, listener);
    return () => {
      listeners.delete(listener);
      unbindListener(listener);
    };
  }

  function bindRuntimeNotificationSession(sessionId) {
    const ownerSessionId = cleanSessionId(sessionId);
    if (!ownerSessionId) return false;
    for (const listener of listeners) bindListenerToSession(ownerSessionId, listener);
    return true;
  }

  function clearRuntimeNotifications() {
    for (const [sessionId, ownedBucket] of boundSessionListeners) {
      const bucket = sessionNotificationListeners.get(sessionId);
      if (!bucket) continue;
      for (const listener of ownedBucket) bucket.delete(listener);
      if (bucket.size === 0) sessionNotificationListeners.delete(sessionId);
    }
    boundSessionListeners.clear();
    listeners.clear();
  }

  return {
    emitRuntimeNotification,
    notifySession,
    notifySessionUi,
    notifyFnForSession,
    notifySessionCompletion,
    subscribeRuntimeNotification,
    bindRuntimeNotificationSession,
    clearRuntimeNotifications,
  };
}
