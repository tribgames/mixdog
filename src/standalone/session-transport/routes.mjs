/**
 * session-transport/routes.mjs — the HTTP front door: /health (identity
 * travels with every probe), the daemon-token gate, client register /
 * deregister, the /events SSE attach, /call, /shutdown and the /upgrade
 * handshake a newer build uses to replace this daemon.
 */
import { sendJson, sendError } from '../../runtime/memory/lib/http-wire.mjs';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from '../session-wire.mjs';

export function createTransportRoutes({
  serverToken,
  drain,
  readBody,
  registry,
  lanes,
  callRoute,
  attachSse,
  getStatus,
  transportMemory,
  onClientsEmpty,
  onUpgradeRequested,
}) {
  const health = (res) => {
    // Identity travels with EVERY health probe: a view negotiates version
    // skew before it attaches, so an embedder can never forget to publish
    // it and leave clients guessing.
    sendJson(res, {
      status: 'ok',
      pid: process.pid,
      clients: registry.lifecycleClientCount(),
      connections: registry.clients.size,
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      capabilityFingerprint: SESSION_CAPABILITY_FINGERPRINT,
      draining: drain.reason || null,
      drainCommitted: drain.committed,
      version: runtimeVersion(),
      ...getStatus(),
      activeCalls: lanes.active,
      queuedCalls: lanes.queued,
      queuedUrgentCalls: lanes.queuedUrgent,
      queuedInteractiveCalls: lanes.queuedInteractive,
      callOwners: lanes.owners,
      callQueues: lanes.snapshot(),
      transportMemory: transportMemory(),
    });
  };

  const register = async (req, res) => {
    const body = await readBody(req);
    if (drain.committed) {
      sendError(res, `daemon is draining: ${drain.reason}`, 503);
      return;
    }
    const clientProtocol = Number(body.protocol);
    if (clientProtocol !== SESSION_PROTOCOL) {
      sendError(res, `session protocol ${SESSION_PROTOCOL} required`, 409);
      return;
    }
    const clientToken = registry.register({
      leadPid: body.leadPid,
      cwd: body.cwd,
      lifecycle: body.lifecycle !== false,
      clientKind: body.clientKind,
      registrationId: body.registrationId,
      revision: body.revision,
    });
    sendJson(res, {
      token: clientToken,
      pid: process.pid,
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
    });
  };

  const deregister = async (req, res) => {
    const body = await readBody(req);
    if (body.token) registry.dropClient(String(body.token), 'deregister');
    sendJson(res, { ok: true });
  };

  const events = (url, res) => {
    const clientToken = url.searchParams.get('token');
    if (!attachSse(clientToken, res)) sendError(res, 'unknown client token', 404);
    // Otherwise the stream stays open.
  };

  const call = async (req, res) => {
    if (drain.committed) {
      sendError(res, `daemon is draining: ${drain.reason}`, 503);
      return;
    }
    const body = await readBody(req);
    await callRoute(body, res);
  };

  const shutdown = (res) => {
    sendJson(res, { ok: true });
    if (typeof onClientsEmpty === 'function') {
      try {
        onClientsEmpty();
      } catch {}
    }
  };

  const upgrade = async (req, res) => {
    const body = await readBody(req);
    const requestedProtocol = Number(body.protocol);
    const requestedRevision = Math.max(0, Number(body.revision) || 0);
    const requestedVersion = String(body.version || '0.0.0');
    const revisionOrder = requestedRevision - SESSION_REVISION;
    const versionOrder = compareRuntimeVersions(requestedVersion, runtimeVersion());
    const newerBuild =
      requestedProtocol === SESSION_PROTOCOL && (revisionOrder > 0 || (revisionOrder === 0 && versionOrder > 0));
    if (!newerBuild) {
      sendError(
        res,
        `replacement must use protocol ${SESSION_PROTOCOL} with a revision/build newer than ${SESSION_REVISION}/${runtimeVersion()}`,
        409
      );
      return;
    }
    sendJson(res, {
      accepted: true,
      protocol: SESSION_PROTOCOL,
      currentRevision: SESSION_REVISION,
      currentVersion: runtimeVersion(),
      requestedRevision,
      requestedVersion,
    });
    queueMicrotask(() => {
      try {
        onUpgradeRequested?.({
          protocol: SESSION_PROTOCOL,
          revision: requestedRevision,
          version: requestedVersion,
        });
      } catch {}
    });
  };

  const tokenRoutes = {
    'POST /client/register': register,
    'POST /client/deregister': deregister,
    'POST /call': call,
    'POST /shutdown': (_req, res) => shutdown(res),
    'POST /upgrade': upgrade,
  };

  return async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathName = url.pathname;
    try {
      if (req.method === 'GET' && pathName === '/health') {
        health(res);
        return;
      }
      const token = req.headers['x-mixdog-daemon-token'];
      if (token !== serverToken) {
        sendError(res, 'forbidden', 403);
        return;
      }
      if (req.method === 'GET' && pathName === '/events') {
        events(url, res);
        return;
      }
      const route = tokenRoutes[`${req.method} ${pathName}`];
      if (route) {
        await route(req, res);
        return;
      }
      sendError(res, 'not found', 404);
    } catch (err) {
      try {
        sendError(res, err?.message || String(err), err?.statusCode || 500);
      } catch {}
    }
  };
}
