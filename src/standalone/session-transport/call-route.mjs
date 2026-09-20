/**
 * session-transport/call-route.mjs — one POST /call: owner-keyed fair
 * dispatch into the call lanes, the callId idempotency cache (a transport
 * retry of the SAME callId must never run a second session mutation), and
 * the 200 {result|error} envelope.
 */
import { sendJson, sendError } from '../../runtime/memory/lib/http-wire.mjs';
import { callSignature, callIdConflict, clientCallOwner } from '../rpc-call-identity.mjs';
import { callLane } from './call-lanes.mjs';

// These routes are safe to replay and can return large snapshots. Keeping
// them in the mutation-dedup cache retained multiple transcript copies for a
// full minute under review polling and pane reconciliation.
const REPLAY_SAFE_CALLS = new Set([
  'project.list',
  'project.inspect',
  'session.list',
  'session.read',
  'session.subscribe',
  'session.unsubscribe',
]);

function ownerKeyFor(clientToken, client, args) {
  const addressedSessionId = String(args?.sessionId || '').trim();
  if (addressedSessionId) return `session:${addressedSessionId}`;
  if (client.leadPid) return `pid:${client.leadPid}`;
  return `client:${clientToken}`;
}

function cachedDispatch(cached, callId, signature) {
  if (cached.resultDropped) {
    // The identity survived memory pressure but its result did not. Fail
    // closed: re-running a settled mutation is never correct.
    return Promise.reject(
      Object.assign(new Error(`callId '${callId}' already ran; its result is no longer retained`), {
        code: 'ECALLRESULTDROPPED',
      })
    );
  }
  // callId is an idempotency key, not a caller-selected overwrite slot. Fail
  // closed while the original keeps its cache identity; dispatching here
  // could execute two side-effecting mutations.
  if (!signature || cached.signature !== signature) return Promise.reject(callIdConflict(callId));
  return cached.promise;
}

export function createCallRoute({ handleCall, clients, lanes, callCache, nowMs }) {
  return async function handleCallRequest(body, res) {
    const clientToken = body.token ? String(body.token) : null;
    const c = clientToken ? clients.get(clientToken) : null;
    if (!c) {
      sendError(res, 'unknown client token', 404);
      return;
    }
    c.lastSeen = nowMs();
    const name = String(body.name || '');
    const callId = body.callId ? String(body.callId) : null;
    const args = body.args || {};
    // Scheduling fairness follows the addressed session, but idempotency
    // belongs to the CALLING PROCESS. Two clients legitimately issuing the
    // same callId against one shared session must not dedupe each other.
    const cacheOwnerKey = clientCallOwner(c, clientToken);
    const cacheKey = callId && !REPLAY_SAFE_CALLS.has(name) ? `${cacheOwnerKey}\u0000${callId}` : null;
    // A retry is the SAME payload under the same id. A different payload
    // that reuses an id (submission ids are caller-supplied) is a NEW call
    // and must never be answered out of another call's result.
    const signature = callId ? callSignature(name, body.args) : null;
    const cached = cacheKey ? callCache.get(cacheKey) : null;
    let dispatch;
    if (cached) {
      dispatch = cachedDispatch(cached, callId, signature);
    } else {
      dispatch = lanes.dispatch(
        ownerKeyFor(clientToken, c, body.args),
        () =>
          handleCall(name, args, {
            clientToken,
            leadPid: c.leadPid ?? null,
            cwd: c.cwd ?? null,
            revision: c.revision ?? 0,
          }),
        { lane: callLane(name, args) }
      );
      if (cacheKey) callCache.track(cacheKey, dispatch, signature);
    }
    try {
      const result = await dispatch;
      sendJson(res, { result });
    } catch (err) {
      // Session call errors travel as a 200 {error} envelope so the client can
      // tell a failed CALL from a dead TRANSPORT (which must re-attach). The
      // machine-readable `code` (ECALLIDCONFLICT / ECALLRESULTDROPPED) travels
      // with it: a client must be able to branch on it, not parse prose.
      sendJson(
        res,
        {
          error: err?.message || String(err),
          ...(err?.code ? { code: String(err.code) } : {}),
        },
        200
      );
    }
  };
}
