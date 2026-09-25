/**
 * http-routes.mjs — the HTTP surface of the channel transport. 127.0.0.1
 * bind already restricts reachability; still refuse anything without the
 * server token except /health (liveness probe is unauthed).
 */
import { readBody, sendJson, sendError } from '../../runtime/memory/lib/http-wire.mjs';
import { replayIdOf } from './client-registry/registration-replays.mjs';

const CHANNEL_HTTP_BODY_MAX_BYTES = 64 * 1024 * 1024;

function readChannelBody(req) {
  return readBody(req, { maxBytes: CHANNEL_HTTP_BODY_MAX_BYTES });
}

export function createChannelRoutes({
  state,
  serverToken,
  getStatus,
  agentBroker,
  onClientsEmpty,
  registry,
  dispatch,
}) {
  const { clients } = state;

  function sendDraining(res) {
    sendError(res, `daemon is draining: ${state.drainingReason}`, 503);
  }

  function health(res) {
    sendJson(res, {
      status: 'ok',
      pid: process.pid,
      clients: clients.size,
      activeCalls: dispatch.active,
      queuedCalls: dispatch.queued,
      callOwners: dispatch.owners,
      draining: state.drainingReason || null,
      drainCommitted: state.drainCommitted,
      ...(agentBroker?.snapshot ? { agentBroker: agentBroker.snapshot() } : {}),
      ...getStatus(),
    });
  }

  async function register(req, res) {
    if (state.drainCommitted) return sendDraining(res);
    const body = await readChannelBody(req);
    const clientToken = registry.registerClient({
      leadPid: body.leadPid,
      cwd: body.cwd,
      passive: body.passive === true,
      replaceToken: body.replaceToken,
      registrationId: body.registrationId,
      restoreSessionId: body.restoreSessionId,
    });
    const replayId = body.passive === true ? replayIdOf(body.registrationId) : null;
    res.once('finish', () => registry.markRegistrationResponseFinished(replayId, clientToken));
    sendJson(res, { token: clientToken, pid: process.pid });
  }

  async function deregister(req, res) {
    const body = await readChannelBody(req);
    if (body.registrationId) {
      const cancelled = registry.cancelReplacementRegistration(body);
      if (cancelled === 'forbidden') return sendError(res, 'forbidden replacement deregister', 403);
      return sendJson(res, { ok: true, cancelled: cancelled === 'cancelled' });
    }
    if (body.token) {
      registry.dropClient(body.token, 'deregister');
    }
    sendJson(res, { ok: true });
  }

  function events(url, res) {
    const clientToken = url.searchParams.get('token');
    if (!registry.attachSse(clientToken, res)) sendError(res, 'unknown client token', 404);
    // Otherwise the stream stays open.
  }

  // Internal memory -> session LLM bridge. It is authenticated with the daemon
  // discovery token but deliberately does NOT register as a channel client:
  // background memory work must not change the pinned session or keep the
  // channels client registry alive. The broker itself owns a parallel fair
  // scheduler and per-call cancellation.
  async function agentDispatch(req, res) {
    if (state.drainCommitted) return sendDraining(res);
    if (!agentBroker?.dispatch) return sendError(res, 'agent broker unavailable', 503);
    const body = await readChannelBody(req);
    const callId = String(body.callId || '').trim();
    if (!callId) return sendError(res, 'callId required', 400);
    res.on('close', () => {
      if (res.writableFinished) return;
      try {
        agentBroker.cancel(callId, 'agent broker client disconnected');
      } catch {}
    });
    try {
      const result = await agentBroker.dispatch(body.params || {}, { callId });
      sendJson(res, { ok: true, result });
    } catch (error) {
      sendJson(res, { ok: false, error: error?.message || String(error) }, 200);
    }
  }

  async function agentCancel(req, res) {
    if (!agentBroker?.cancel) return sendError(res, 'agent broker unavailable', 503);
    const body = await readChannelBody(req);
    const callId = String(body.callId || '').trim();
    if (!callId) return sendError(res, 'callId required', 400);
    const reason = String(body.reason || 'memory agent dispatch canceled');
    const cancelled = agentBroker.cancelAndWait
      ? await agentBroker.cancelAndWait(callId, reason)
      : agentBroker.cancel(callId, reason);
    sendJson(res, { ok: true, cancelled });
  }

  async function call(req, res) {
    if (state.drainCommitted) return sendDraining(res);
    const body = await readChannelBody(req);
    const clientToken = body.token || null;
    const c = clientToken ? clients.get(clientToken) : null;
    if (!c) return sendError(res, 'unknown client token', 404);
    registry.forgetReplaysFor(clientToken);
    c.lastSeen = Date.now();
    try {
      const result = await dispatch.dispatchCall(body, c, clientToken);
      sendJson(res, { result });
    } catch (err) {
      // Keep the machine-readable code beside the message: callers branch on
      // it instead of pattern-matching free text.
      sendJson(
        res,
        {
          error: err?.message || String(err),
          ...(err?.code ? { code: String(err.code) } : {}),
        },
        200
      );
    }
  }

  function shutdown(res) {
    sendJson(res, { ok: true });
    if (typeof onClientsEmpty === 'function') {
      try {
        onClientsEmpty();
      } catch {}
    }
  }

  return async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathName = url.pathname;
    try {
      if (req.method === 'GET' && pathName === '/health') return health(res);
      const token = req.headers['x-mixdog-daemon-token'];
      if (token !== serverToken) return sendError(res, 'forbidden', 403);
      if (req.method === 'POST' && pathName === '/client/register') return await register(req, res);
      if (req.method === 'POST' && pathName === '/client/deregister') return await deregister(req, res);
      if (req.method === 'GET' && pathName === '/events') return events(url, res);
      if (req.method === 'POST' && pathName === '/agent/dispatch') return await agentDispatch(req, res);
      if (req.method === 'POST' && pathName === '/agent/cancel') return await agentCancel(req, res);
      if (req.method === 'POST' && pathName === '/call') return await call(req, res);
      if (req.method === 'POST' && pathName === '/shutdown') return shutdown(res);
      sendError(res, 'not found', 404);
    } catch (err) {
      try {
        sendError(res, err?.message || String(err), err?.statusCode || 500);
      } catch {}
    }
  };
}
