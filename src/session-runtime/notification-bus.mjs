// Runtime notification fan-out. A notification reaches listeners (TUI/API) and,
// for terminal tool completions, may also be mirrored into the session's
// pending queue so the model sees it next turn. The delivered registry keeps
// those two paths from double-injecting the same completion.
import { modelVisibleToolCompletionMessage } from '../runtime/shared/tool-execution-contract.mjs';
import {
  PENDING_MODE_TASK_NOTIFICATION,
  markCompletionEntry,
} from '../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
import {
  isDeliveredCompletion,
  logDuplicateSkip,
  recordDeliveredCompletion,
} from '../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { shouldMirrorCompletionToPendingQueue } from './runtime-tool-routing.mjs';
import { notifyTrace } from '../runtime/shared/notify-trace.mjs';

const sessionNotificationListeners = new Map();
// A completion that waits this long between enqueue and wake is reported: the
// queue is durable, so the delay is a scheduling symptom, not a lost message.
const WAKE_DELAY_REPORT_MS = 1_000;

function cleanSessionId(value) {
  return String(value || '').trim();
}

// A queued completion only reaches the model on the next turn, so a session
// with no user input pending is woken with an empty turn. One wake per session
// runs at a time, and a completion suppressed by that in-flight wake is
// remembered and replayed once it settles: the suppressed completion may have
// landed after the woken turn took its last look at the queue, and dropping
// the wake would leave its durable entry parked until the next user message.
// A completion whose owner is no longer the live session is still dropped (the
// durable queue carries it into that session's next turn).
export function createCompletionWakeScheduler({ getCurrentSessionId, getTurnApi, getOwnerLifecycle, beforeWake }) {
  // A closing/terminal owner never starts inference from a completion; the
  // check runs at request time and again inside the delayed callback.
  const ownerOpen = (sessionId) => {
    const life = getOwnerLifecycle?.(sessionId);
    return !life || life.state === 'open';
  };
  // sessionId -> the oldest request suppressed while this session's wake is in
  // flight, or null when nothing was suppressed. A present key means in flight.
  const inFlight = new Map();

  function runWake(ownerSessionId, { executionId, enqueuedAt }) {
    inFlight.set(ownerSessionId, null);
    setImmediate(async () => {
      const queuedAt = Number(enqueuedAt) || Date.now();
      try {
        const turnApi = getTurnApi();
        if (cleanSessionId(getCurrentSessionId()) !== ownerSessionId || !turnApi) return;
        if (!ownerOpen(ownerSessionId)) return;
        const delayMs = Math.max(0, Date.now() - queuedAt);
        if (delayMs >= WAKE_DELAY_REPORT_MS) {
          process.stderr.write(
            `[notification] delayed completion wake sessionId=${ownerSessionId}` +
              ` executionId=${executionId || 'unknown'} queuedMs=${delayMs}\n`
          );
        }
        // Surface hook (idle auto-clear): compacts a cold-cache session before
        // the wake sends it. A failing hook never blocks the wake.
        if (typeof beforeWake === 'function') {
          try {
            await beforeWake(ownerSessionId);
          } catch {
            // The pre-wake hook is best-effort; the wake proceeds without it.
          }
          if (cleanSessionId(getCurrentSessionId()) !== ownerSessionId || !ownerOpen(ownerSessionId)) return;
        }
        // The wake continues the user turn that launched the worker, so its
        // review keeps that turn's Lead edits and worker diffs.
        await turnApi.ask('', { submittedAt: queuedAt, continueTurn: true });
      } catch (err) {
        try {
          process.stderr.write(
            `[notification] completion wake failed sessionId=${ownerSessionId}` +
              ` executionId=${executionId || 'unknown'} err=${err?.message || err}\n`
          );
        } catch {}
      } finally {
        const replay = inFlight.get(ownerSessionId) || null;
        inFlight.delete(ownerSessionId);
        // Bounded: only a wake call suppressed during this one arms a replay,
        // so a replay that suppressed nothing ends the chain.
        if (replay) runWake(ownerSessionId, replay);
      }
    });
  }

  return function wakeQueuedCompletion({ sessionId, executionId, enqueuedAt } = {}) {
    const ownerSessionId = cleanSessionId(sessionId);
    if (!ownerSessionId || !ownerOpen(ownerSessionId)) return false;
    if (inFlight.has(ownerSessionId)) {
      const suppressed = inFlight.get(ownerSessionId);
      // Keep the oldest suppressed request so the replay reports the real wait.
      if (!suppressed || (Number(enqueuedAt) || Infinity) < (Number(suppressed.enqueuedAt) || Infinity)) {
        inFlight.set(ownerSessionId, { executionId, enqueuedAt });
      }
      return false;
    }
    runWake(ownerSessionId, { executionId, enqueuedAt });
    return true;
  };
}

function emitToListeners(source, content, meta = {}, origin = null) {
  const text = String(content || '').trim();
  if (!text) return { handled: false, modelVisibleDelivered: false };
  const event = {
    content: text,
    meta: meta && typeof meta === 'object' ? meta : {},
    // The notification's provenance apart from its meta (PROMPT_ORIGIN_CHANNEL).
    ...(origin ? { origin } : {}),
  };
  let handled = false;
  for (const listener of [...source]) {
    try {
      if (listener(event) === true) handled = true;
    } catch {
      /* a broken listener never blocks the rest */
    }
  }
  return { handled, modelVisibleDelivered: event.modelVisibleDelivered === true };
}

export function createNotificationBus({ listeners, mgr, onCompletionQueued, getOwnerLifecycle }) {
  const boundSessionListeners = new Map();
  const queuedCompletionIds = new Map();

  // Owner identity + lifecycle generation. A closing/terminal owner (or a
  // callback captured under an earlier generation) keeps its result for
  // UI/history only: it is flagged `owner_closed`, never queued for the model
  // and never wakes inference.
  function ownerOpen(sessionId, capturedGeneration) {
    const life = getOwnerLifecycle?.(sessionId);
    if (!life) return true;
    if (life.state !== 'open') return false;
    return capturedGeneration === undefined || capturedGeneration === life.generation;
  }
  const closedMeta = (meta) => ({ ...(meta && typeof meta === 'object' ? meta : {}), owner_closed: true });

  function emitRuntimeNotification(content, meta = {}) {
    return emitToListeners(listeners, content, meta);
  }

  // `origin`: the notification's provenance (PROMPT_ORIGIN_CHANNEL for an
  // inbound channel message), carried to the queue beside its mode.
  function notifySession(sessionId, content, meta = {}, { origin = null } = {}) {
    const targetSessionId = cleanSessionId(sessionId);
    if (!targetSessionId) return false;
    const targetListeners = sessionNotificationListeners.get(targetSessionId) || [];
    const open = ownerOpen(targetSessionId);
    const { handled } = emitToListeners(targetListeners, content, open ? meta : closedMeta(meta), origin);
    if (handled) return true;
    if (!open) return false;
    if (typeof mgr.enqueuePendingMessage !== 'function') return false;
    try {
      // A channel notification (webhook event rules, schedule injects, relays)
      // is the runtime reporting, exactly as an attached TUI queues it: a
      // task notification, so text inside it — fenced external webhook values
      // included — never drives explicit skill selection.
      return (
        mgr.enqueuePendingMessage(targetSessionId, {
          content,
          mode: PENDING_MODE_TASK_NOTIFICATION,
          ...(origin ? { origin } : {}),
        }) > 0
      );
    } catch {
      return false;
    }
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
      } catch {
        /* wake-up is best-effort; the durable queue remains authoritative */
      }
    }
    return true;
  }

  function notifySessionCompletion(sessionId, text, meta = {}, capturedGeneration = undefined) {
    const targetSessionId = cleanSessionId(sessionId);
    if (!targetSessionId) return false;
    const targetListeners = sessionNotificationListeners.get(targetSessionId) || [];
    const open = ownerOpen(targetSessionId, capturedGeneration);
    const ownerMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      caller_session_id: targetSessionId,
      ...(open ? {} : { owner_closed: true }),
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
    if (!open) return handled;
    if (modelVisibleDelivered) {
      try {
        recordDeliveredCompletion({
          executionId: meta?.execution_id,
          text: modelVisibleToolCompletionMessage(text, ownerMeta),
        });
      } catch {
        /* registry is best-effort */
      }
    }
    const mustQueue =
      !handled ||
      shouldMirrorCompletionToPendingQueue({
        callerSessionId: targetSessionId,
        modelVisibleDelivered,
        hasEnqueue: typeof mgr.enqueuePendingMessage === 'function',
        text,
        meta: ownerMeta,
      });
    let enqueued = false;
    if (mustQueue && typeof mgr.enqueuePendingMessage === 'function') {
      try {
        enqueued = enqueueCompletion(targetSessionId, text, ownerMeta, 'owner');
      } catch {
        /* best-effort */
      }
    }
    return enqueued || handled;
  }

  function notifyFnForSession(callerSessionId) {
    const ownerSessionId = cleanSessionId(callerSessionId);
    const generation = getOwnerLifecycle?.(ownerSessionId)?.generation;
    return (text, meta = {}) => notifySessionCompletion(ownerSessionId, text, meta, generation);
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
