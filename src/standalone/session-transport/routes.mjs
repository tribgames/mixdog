/**
 * session-transport/routes.mjs — the HTTP front door: /health (identity
 * travels with every probe), the daemon-token gate, client register /
 * deregister / heartbeat, the /events SSE attach, /call, /shutdown, /stop and the /upgrade
 * handshake a newer build uses to replace this daemon.
 */
import { readFileSync } from 'node:fs';
import { sendJson, sendError } from '../../runtime/memory/lib/http-wire.mjs';
import { modelProxyClientMode } from '../../runtime/shared/model-proxy-mode.mjs';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from '../session-wire.mjs';

let installBuildHash;
/** Build hash of a desktop-installed server runtime: the `.install-complete`
 *  marker the installer writes at the package root. Null for any other
 *  install (npm, source checkout, packaged desktop). */
function remoteInstallBuildHash() {
  if (installBuildHash !== undefined) return installBuildHash;
  try {
    const marker = JSON.parse(readFileSync(new URL('../../../.install-complete', import.meta.url), 'utf8'));
    installBuildHash = typeof marker?.buildHash === 'string' && marker.buildHash ? marker.buildHash : null;
  } catch {
    installBuildHash = null;
  }
  return installBuildHash;
}

/** Turns in flight: what makes a daemon too busy to replace without asking. */
function busySessionCount(status) {
  return Math.max(0, Number(status?.busy) || 0);
}

/** Leave through the embedder's own graceful SIGTERM path. */
function requestProcessStop() {
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');
  else process.kill(process.pid, 'SIGTERM');
}

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
  admitWork = () => true,
}) {
  // Checked on every register/call, last right before the work is handed on
  // (after the body is read): a daemon that lost (or cannot re-verify) its
  // owner lease serves nothing. `admitWork` may answer asynchronously (a
  // request arriving during the lease's re-verification waits for it).
  const refuseUnadmitted = async (res) => {
    if (await admitWork()) return false;
    sendError(res, 'daemon owner lease is not held', 503);
    return true;
  };

  const health = (res) => {
    // Identity travels with EVERY health probe: a view negotiates version
    // skew before it attaches, so an embedder can never forget to publish
    // it and leave clients guessing.
    const status = getStatus();
    const busySessions = busySessionCount(status);
    sendJson(res, {
      status: 'ok',
      pid: process.pid,
      clients: registry.lifecycleClientCount(),
      connections: registry.clients.size,
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      capabilityFingerprint: SESSION_CAPABILITY_FINGERPRINT,
      modelProxy: modelProxyClientMode() ? 'client' : null,
      draining: drain.reason || null,
      drainCommitted: drain.committed,
      version: runtimeVersion(),
      packageVersion: runtimeVersion(),
      buildHash: remoteInstallBuildHash(),
      ...status,
      busySessions,
      idle: busySessions === 0,
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
    if (await refuseUnadmitted(res)) return;
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
      remote: body.remote === true,
      leaseMs: body.leaseMs,
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

  // Lease keep-alive for remote clients (the daemon token gate already ran).
  const heartbeat = async (req, res) => {
    const body = await readBody(req);
    if (!body.token || !registry.touch(String(body.token))) {
      sendError(res, 'unknown client token', 404);
      return;
    }
    sendJson(res, { ok: true });
  };

  const events = (url, res) => {
    const clientToken = url.searchParams.get('token');
    if (!attachSse(clientToken, res)) sendError(res, 'unknown client token', 404);
    // Otherwise the stream stays open.
  };

  const call = async (req, res) => {
    if (await refuseUnadmitted(res)) return;
    if (drain.committed) {
      sendError(res, `daemon is draining: ${drain.reason}`, 503);
      return;
    }
    const body = await readBody(req);
    // Again right before dispatch: the lease may have been fenced while the
    // body was still arriving.
    if (await refuseUnadmitted(res)) return;
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

  // Authenticated stop for a desktop replacing this daemon with another
  // build: refused while turns run unless forced (the user confirmed).
  const stop = async (req, res) => {
    const body = await readBody(req);
    const busySessions = busySessionCount(getStatus());
    if (busySessions > 0 && body.force !== true) {
      sendError(res, `daemon is busy: ${busySessions} running session(s)`, 409);
      return;
    }
    sendJson(res, { ok: true, pid: process.pid, busySessions });
    setImmediate(requestProcessStop);
  };

  const upgrade = async (req, res) => {
    const body = await readBody(req);
    const requestedProtocol = Number(body.protocol);
    const requestedRevision = Math.max(0, Number(body.revision) || 0);
    const requestedVersion = String(body.version || '0.0.0');
    const force = body.force === true;
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
          force,
        });
      } catch {}
    });
  };

  const tokenRoutes = {
    'POST /client/register': register,
    'POST /client/deregister': deregister,
    'POST /client/heartbeat': heartbeat,
    'POST /call': call,
    'POST /shutdown': (_req, res) => shutdown(res),
    'POST /stop': stop,
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
