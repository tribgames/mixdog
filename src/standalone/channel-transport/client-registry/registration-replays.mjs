// Reconnect register replay: a server may commit a replacement just before
// its HTTP response is lost. The retry supplies the same stable registration
// id and receives the already-created fresh token instead of creating an
// orphan replacement. Each record carries the full logical-client identity so
// a replay or a cancellation can never touch another client, and a TTL bounds
// how long an unflushed registration can stay cancellable.
import { parsePid } from '../../../runtime/shared/pid-liveness.mjs';

const replayIdOf = (registrationId) => (registrationId ? String(registrationId).slice(0, 200) : null);

/** A replayed reconnect must name the same logical client. */
export function replayMatchesRegistration(replay, { pid, cwd, replacementToken, restoreId }) {
  return (
    replay.leadPid === pid &&
    replay.cwd === (cwd || null) &&
    replay.replaceToken === replacementToken &&
    replay.restoreSessionId === restoreId
  );
}

/** A response-loss close knows only its retired token + stable registration
 *  id; cancellation binds to every field so a malformed/mismatched request
 *  cannot retire someone else's fresh token. */
export function replayMatchesCancellation(replay, { token, replaceToken, leadPid, cwd, restoreSessionId }) {
  const retiredToken = token ? String(token) : null;
  return (
    retiredToken === replay.replaceToken &&
    String(replaceToken || '') === replay.replaceToken &&
    parsePid(leadPid) === replay.leadPid &&
    (cwd || null) === replay.cwd &&
    String(restoreSessionId || '') === String(replay.restoreSessionId || '')
  );
}

export function createRegistrationReplays({ registrationReplays, ttlMs, onExpiredUnflushed }) {
  const ttl = Math.max(1, Number(ttlMs) || 60_000);

  function remove(replayId, replay = registrationReplays.get(replayId)) {
    if (!replay || registrationReplays.get(replayId) !== replay) return;
    registrationReplays.delete(replayId);
    try {
      clearTimeout(replay.timer);
    } catch {}
  }

  /** Forget every replay record that names `token` (a live stream or a call
   *  proves the client learned its fresh token). */
  function forgetFor(token) {
    for (const [replayId, replay] of registrationReplays) {
      if (replay.token === token) remove(replayId, replay);
    }
  }

  function clear() {
    for (const [replayId, replay] of registrationReplays) remove(replayId, replay);
  }

  /** (Re)starts the record's TTL. A successfully flushed register response
   *  creates a valid client even if its SSE/call is delayed; the TTL only
   *  bounds cancellation metadata and retires an UNFLUSHED registration. */
  function arm(replayId, replay) {
    try {
      clearTimeout(replay.timer);
    } catch {}
    replay.timer = setTimeout(() => {
      if (registrationReplays.get(replayId) !== replay) return;
      remove(replayId, replay);
      if (!replay.responseFinished) onExpiredUnflushed(replay.token);
    }, ttl);
    replay.timer.unref?.();
  }

  function remember(replayId, replay) {
    registrationReplays.set(replayId, replay);
    arm(replayId, replay);
  }

  function markResponseFinished(registrationId, token) {
    const replay = registrationId ? registrationReplays.get(registrationId) : null;
    if (replay && replay.token === token) replay.responseFinished = true;
  }

  return {
    replayIdOf,
    lookup: (registrationId) => {
      const replayId = replayIdOf(registrationId);
      return replayId ? (registrationReplays.get(replayId) ?? null) : null;
    },
    remove,
    forgetFor,
    clear,
    arm,
    remember,
    markResponseFinished,
  };
}
