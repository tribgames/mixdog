import { randomUUID } from 'node:crypto';

/** One addressed request, one desktop claimant, one receipt. Snapshot replay
 * carries only an id; it cannot replay a mutation after expiry or completion. */
export function createSetupUiRequests({ notifySessionUi, getSessionId, claimTimeoutMs = 15_000, executionTimeoutMs = 900_000 }) {
  const pending = new Map();
  function finish(id, error, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
    return true;
  }
  function request(args, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('setup: cancelled before Desktop execution'));
    const sessionId = String(getSessionId?.() || '');
    if (!sessionId) return Promise.reject(new Error('setup: open this conversation in Desktop to change desktop-host settings'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const entry = {
        args, sessionId, resolve, reject, owner: null,
        signal,
        abort: () => finish(id, 'setup: cancelled. If Desktop already started, inspect its state before retrying.'),
        expiresAt: Date.now() + claimTimeoutMs,
        timer: setTimeout(() => finish(id, 'setup: no Desktop window claimed the request; nothing was changed'), claimTimeoutMs),
      };
      pending.set(id, entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (notifySessionUi?.(sessionId, 'Desktop settings request', { kind: 'setup-ui', id }) !== true) {
        finish(id, 'setup: no attached Desktop surface; nothing was changed');
      }
    });
  }
  return {
    request,
    isSetupRequestActive(id, owner) {
      const entry = pending.get(id);
      return Boolean(entry && entry.owner === owner && !entry.signal?.aborted
        && entry.sessionId === String(getSessionId?.() || ''));
    },
    claimSetupRequest(id, owner) {
      const entry = pending.get(id);
      if (!entry || entry.owner || entry.expiresAt <= Date.now() || !String(owner || '').trim()) return null;
      if (entry.sessionId !== String(getSessionId?.() || '')) return null;
      entry.owner = owner;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => finish(id, 'setup: Desktop did not return a receipt. The operation may still be running; inspect its state before retrying.'),
        executionTimeoutMs
      );
      return { id, args: entry.args, scope: 'desktop-host' };
    },
    completeSetupRequest(id, owner, receipt) {
      const entry = pending.get(id);
      if (!entry || entry.owner !== owner) return false;
      if (!receipt || typeof receipt !== 'object') throw new Error('setup receipt is required');
      return finish(id, receipt.error ? String(receipt.error) : null, receipt.result);
    },
    dispose() {
      for (const id of [...pending.keys()]) finish(id, 'setup: session closed before Desktop confirmed the operation');
    },
  };
}
