// Client registration for the channel transport: a fresh record per attach,
// a passive reconnect's response-loss replay, the replaced token's retirement
// with its token-scoped state carried over, and the replacement's
// cancellation. `records` is the registry's client records (client-records).
import { randomUUID } from 'node:crypto';
import { parsePid } from '../../../runtime/shared/pid-liveness.mjs';
import { replayMatchesCancellation, replayMatchesRegistration } from './registration-replays.mjs';

export function createClientRegistration({ state, log, onClientRegistered, replays, grace, records }) {
  const { clients } = state;

  function cancelReplacementRegistration(request) {
    const replay = replays.lookup(request.registrationId);
    if (!replay) return 'missing';
    if (!replayMatchesCancellation(replay, request)) return 'forbidden';
    records.dropClient(replay.token, 'replacement deregister');
    return 'cancelled';
  }

  /** A passive reconnect retrying under a known registration id gets the fresh
   *  token it already created; a different identity under that id is a 409. */
  function replayedToken(replayId, identity) {
    const existing = replays.lookup(replayId);
    if (!existing) return null;
    if (replayMatchesRegistration(existing, identity) && clients.has(existing.token)) {
      replays.arm(replayId, existing);
      log(`client reconnect replay token=${existing.token} lead=${identity.pid}`);
      return existing.token;
    }
    if (clients.has(existing.token)) {
      const err = new Error('registration replay identity mismatch');
      err.statusCode = 409;
      throw err;
    }
    replays.remove(replayId, existing);
    return null;
  }

  /** A reconnect names the exact token it replaces. Token-scoped state belongs
   *  to the logical client, so the fresh record inherits the buffered frame,
   *  remote session and pointer; the old token is retired even when it is not
   *  the pointer — retaining it would let it later call or accumulate a
   *  buffered frame after the fresh client has gone away. */
  function adoptReplacedClient(fresh, replaced) {
    const replacedWasPointer = state.pointerToken === replaced.token;
    if (replaced.pendingRemoteStateFrame) {
      fresh.pendingRemoteStateFrame = replaced.pendingRemoteStateFrame;
      replaced.pendingRemoteStateFrame = null;
    }
    if (replaced.remoteSessionId) fresh.remoteSessionId = replaced.remoteSessionId;
    if (replaced.restoreSessionId) fresh.restoreSessionId = replaced.restoreSessionId;
    if (replacedWasPointer) state.pointerToken = fresh.token;
    records.removeClientRecord(replaced.token);
    log(`client reconnect replaced token=${replaced.token} -> ${fresh.token} lead=${fresh.leadPid}`);
  }

  function registerClient({
    leadPid,
    cwd,
    passive = false,
    replaceToken = null,
    registrationId = null,
    restoreSessionId = null,
  }) {
    const pid = parsePid(leadPid) ?? 0;
    const restoreId = /^[A-Za-z0-9_-]+$/.test(String(restoreSessionId || '')) ? String(restoreSessionId) : null;
    const replacementToken = replaceToken ? String(replaceToken) : null;
    const replayId = passive && registrationId ? replays.replayIdOf(registrationId) : null;
    const replayed = replayedToken(replayId, { pid, cwd, replacementToken, restoreId });
    if (replayed) return replayed;
    const token = randomUUID();
    const fresh = {
      token,
      leadPid: pid,
      cwd: cwd || null,
      sse: null,
      pendingRemoteStateFrame: null,
      lastSeen: Date.now(),
      registeredAt: Date.now(),
      restoreSessionId: restoreId,
    };
    clients.set(token, fresh);
    if (state.remoteAcquired && restoreId && restoreId === state.pinnedSessionId) fresh.remoteSessionId = restoreId;
    state.everHadClient = true;
    grace.cancel();
    grace.resetBackoff();
    grace.startSweep();
    log(`client registered token=${token} lead=${pid} cwd=${cwd || '-'}`);
    // The unified daemon starts the channels runtime (automation, webhooks)
    // only once a CHANNELS client is actually present — a
    // session runtime-only daemon must not run tunnels nobody asked for.
    if (typeof onClientRegistered === 'function') {
      try {
        onClientRegistered({ token, leadPid: pid, cwd: cwd || null });
      } catch {
        // The registered-client hook must not fail the registration itself.
      }
    }
    // Token replacement never crosses leadPid boundaries. Registration is
    // otherwise transport-only, including same-pid fresh attaches.
    const replaced = passive && replacementToken ? clients.get(replacementToken) : null;
    if (replaced && replaced.leadPid === pid) adoptReplacedClient(fresh, replaced);
    if (replayId) {
      replays.remember(replayId, {
        token,
        leadPid: pid,
        cwd: cwd || null,
        replaceToken: replacementToken,
        restoreSessionId: restoreId,
        responseFinished: false,
        timer: null,
      });
    }
    return token;
  }

  return { registerClient, cancelReplacementRegistration };
}
