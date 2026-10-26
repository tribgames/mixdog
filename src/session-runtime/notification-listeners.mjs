// Session-bound runtime notification listeners (notification-bus.mjs). The
// per-session listener sets are process-wide; each bus owns which of its
// listeners it bound to which session, and unbinds only those.

const sessionNotificationListeners = new Map();

export function cleanSessionId(value) {
  return String(value || '').trim();
}

/** The listeners bound to one session (an empty array when none). */
export function sessionListenersOf(sessionId) {
  return sessionNotificationListeners.get(sessionId) || [];
}

export function createListenerBindings({ listeners }) {
  const boundSessionListeners = new Map();

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

  return { subscribeRuntimeNotification, bindRuntimeNotificationSession, clearRuntimeNotifications };
}
