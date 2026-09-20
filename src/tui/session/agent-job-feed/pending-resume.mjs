import { shortTextFingerprint } from '../queue-helpers.mjs';

// Execution completions that land while the session is busy (or while a
// pending-resume turn is already queued) accumulate here and are merged into
// ONE resume turn. Esc-discarded completions leave short-lived tombstones so a
// late duplicate racing the abort is dropped.

export function executionResumeKey(body, completionKey = '') {
  if (completionKey && typeof completionKey === 'object') {
    completionKey = completionKey.executionId || completionKey.key || '';
  }
  const explicitKey = String(completionKey || '').trim();
  if (explicitKey.startsWith('execution:') || explicitKey.startsWith('body:')) return explicitKey;
  if (explicitKey) return `execution:${explicitKey}`;
  const value = String(body || '').trim();
  return value ? `body:${shortTextFingerprint(value)}` : '';
}

export function createPendingResume({
  getState,
  getDisposed,
  drain,
  makeQueueEntry,
  getPending,
  now,
  tombstoneTtlMs,
  tombstoneLimit,
}) {
  let deferred = false;
  // Completion keys explicitly abandoned by Esc. Tombstones are per-feed
  // (therefore per TUI session), short-lived, and bounded: they catch a late
  // duplicate racing the abort without permanently reserving execution IDs or
  // retaining completion bodies.
  const discardedKeys = new Map();
  // FIFO accumulation of model-visible bodies from completions that arrived
  // while busy. A single string slot dropped all-but-the-last body when
  // parallel completions landed; the queue preserves every body.
  const bodies = [];

  function pruneDiscarded() {
    const nowMs = Number(now()) || Date.now();
    for (const [key, expiresAt] of discardedKeys) {
      if (expiresAt <= nowMs) discardedKeys.delete(key);
    }
  }

  function isDiscarded(key) {
    if (!key) return false;
    pruneDiscarded();
    return discardedKeys.has(key);
  }

  function rememberDiscarded(key) {
    if (!key) return;
    pruneDiscarded();
    const limit = Math.max(1, Number(tombstoneLimit) || 128);
    while (!discardedKeys.has(key) && discardedKeys.size >= limit) {
      const oldest = discardedKeys.keys().next().value;
      if (oldest == null) break;
      discardedKeys.delete(oldest);
    }
    const ttlMs = Math.max(1, Number(tombstoneTtlMs) || 30_000);
    // Refresh insertion order so the bounded map evicts the oldest tombstone.
    discardedKeys.delete(key);
    discardedKeys.set(key, (Number(now()) || Date.now()) + ttlMs);
  }

  // Drain every accumulated body into ONE resume turn so no completion body
  // is lost when several deferred while busy.
  function queueResumeTurn(pending) {
    const resumeBodies = bodies.splice(0);
    const resumeBody = resumeBodies
      .map(({ body }) => body)
      .filter(Boolean)
      .join('\n\n');
    const resumeCompletionKeys = resumeBodies.map(({ key }) => key).filter(Boolean);
    pending.push(
      makeQueueEntry(resumeBody, {
        mode: 'pending-resume',
        priority: 'next',
        abortDiscardOnAbort: true,
        resumeCompletionKeys,
      })
    );
    void drain();
  }

  function kick(body = '', completionKey = '') {
    const key = executionResumeKey(body, completionKey);
    if (body && isDiscarded(key)) return;
    if (body) bodies.push({ body, key });
    if (getDisposed()) return;
    if (getState().busy) {
      deferred = true;
      return;
    }
    const pending = getPending();
    if (pending.some((entry) => entry.mode === 'pending-resume')) {
      deferred = true;
      return;
    }
    deferred = false;
    queueResumeTurn(pending);
  }

  function flushDeferred() {
    if (!deferred || getDisposed() || getState().busy) return;
    kick();
  }

  // Carry the model-visible body directly into the pending-resume entry so the
  // resumed turn sends it, instead of relying on the session-pending
  // completion marker (dropped by askSession pre-drain).
  function schedule(body = '', completionKey = '') {
    queueMicrotask(() => kick(body, completionKey));
  }

  function discard(completionKeys = []) {
    const keys = (Array.isArray(completionKeys) ? completionKeys : [completionKeys])
      .map((key) => executionResumeKey('', key))
      .filter(Boolean);
    if (keys.length === 0) return;
    for (const key of keys) rememberDiscarded(key);
    for (let i = bodies.length - 1; i >= 0; i -= 1) {
      if (isDiscarded(bodies[i].key)) bodies.splice(i, 1);
    }
    deferred = bodies.length > 0;
  }

  return { kick, flushDeferred, schedule, discard, isDiscarded };
}
