/**
 * client-registry/registration-replays.mjs — a timed-out registration may
 * already have committed server-side. Replaying the same registrationId
 * returns that token instead of leaking a second client record and another
 * lifecycle reference.
 */
const REGISTRATION_REPLAY_TTL_MS = 30_000;
const REGISTRATION_REPLAY_MAX = 256;

export function createRegistrationReplays({ clients, log }) {
  const registrationReplays = new Map();

  // A stream proves receipt of its token, ending registration replay; a
  // removed client can never replay either.
  function forgetFor(token) {
    for (const [registrationId, replay] of registrationReplays) {
      if (replay.token === token) {
        clearTimeout(replay.timer);
        registrationReplays.delete(registrationId);
      }
    }
  }

  // Returns the replayed token, or null when this registration must create a
  // fresh client. Throws 409 when the id is reused with a different identity
  // while the original client is still attached.
  function replayedToken(replayId, identity) {
    const replay = replayId ? registrationReplays.get(replayId) : null;
    if (!replay) return null;
    const sameIdentity =
      replay.leadPid === identity.leadPid &&
      replay.cwd === identity.cwd &&
      replay.lifecycle === identity.lifecycle &&
      replay.clientKind === identity.clientKind &&
      replay.revision === identity.revision;
    if (sameIdentity && clients.has(replay.token)) {
      log(`client registration replay token=${replay.token} lead=${identity.leadPid}`);
      return replay.token;
    }
    if (clients.has(replay.token)) {
      const error = new Error('registration replay identity mismatch');
      error.statusCode = 409;
      throw error;
    }
    clearTimeout(replay.timer);
    registrationReplays.delete(replayId);
    return null;
  }

  function remember(replayId, token, identity) {
    while (registrationReplays.size >= REGISTRATION_REPLAY_MAX) {
      const oldest = registrationReplays.keys().next();
      if (oldest.done) break;
      const prior = registrationReplays.get(oldest.value);
      clearTimeout(prior?.timer);
      registrationReplays.delete(oldest.value);
    }
    const timer = setTimeout(() => registrationReplays.delete(replayId), REGISTRATION_REPLAY_TTL_MS);
    timer.unref?.();
    registrationReplays.set(replayId, { token, ...identity, timer });
  }

  function clear() {
    for (const replay of registrationReplays.values()) clearTimeout(replay.timer);
    registrationReplays.clear();
  }

  return { forgetFor, replayedToken, remember, clear };
}
