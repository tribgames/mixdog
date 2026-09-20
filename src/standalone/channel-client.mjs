// Machine-global channel service — attach client (TUI side).
//
// Mirrors the memory proxy's attach pattern (POST /client/register + /health,
// 127.0.0.1 only). A TUI uses this to talk to the shared channel front door
// instead of forking its own worker: tool calls go over POST /call and the
// worker->parent notify path arrives on a persistent SSE stream (GET /events),
// replacing the old node-IPC `{type:'notify'}` messages. The pieces live under
// ./channel-client/:
//   daemon-request — one JSON request, the health probe, the /call wrapper
//   registration   — pid verification, passive register/re-register, deregister
//   notify-stream  — the SSE request plus its stable/liveness timers
//   reconnect      — bounded retry with a lifecycle generation
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { isPidAlive, parsePid } from '../runtime/shared/pid-liveness.mjs';
import { createChannelCall, probeChannelHealth } from './channel-client/daemon-request.mjs';
import { createNotifyStream } from './channel-client/notify-stream.mjs';
import { createReconnectLoop } from './channel-client/reconnect.mjs';
import { createRegistrationClient, staleDiscoveryError } from './channel-client/registration.mjs';

export { probeChannelHealth };

function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// Read + validate the discovery file. Returns null when missing/corrupt or when
// the recorded pid is dead (stale daemon) so the caller reclaims + respawns.
export function readChannelDiscovery(discoveryPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(discoveryPath, 'utf8'));
  } catch {
    return null;
  }
  const endpoint = raw?.endpoints?.channel;
  const port = parsePort(endpoint?.port);
  const pid = parsePid(raw?.pid);
  if (!port || !pid || !endpoint?.token) return null;
  if (!isPidAlive(pid)) return null; // dead daemon → treat as absent
  return { port, pid, token: String(endpoint.token) };
}

// Attach to a live daemon described by `discovery` ({port, pid, token}).
// Registers this client, opens the notify SSE stream, and returns a handle
// whose call() dispatches channel tools over HTTP. onNotify receives the SAME
// `{type:'notify', method, params}` shape the old IPC path delivered, so the
// TUI-side onNotify handler stays unchanged (thin glue).
export async function attachChannel({
  discovery,
  leadPid = process.pid,
  cwd = process.cwd(),
  restoreSessionId = null,
  onNotify = () => {},
  log = () => {},
  onFatal = () => {},
} = {}) {
  const expectedPid = parsePid(discovery?.pid);
  if (!discovery?.port || !discovery?.token || !expectedPid)
    throw new Error('daemon discovery {port, pid, token} required');
  const { port, token: serverToken } = discovery;
  const callAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 16, maxFreeSockets: 4 });
  const controlAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 4, maxFreeSockets: 2 });
  const registry = createRegistrationClient({
    port,
    serverToken,
    agent: controlAgent,
    expectedPid,
    leadPid,
    cwd,
    restoreSessionId,
  });

  if (!(await registry.probeExpectedDaemon())) throw staleDiscoveryError('daemon discovery pid does not match health');
  let clientToken = await registry.registerInitial();
  let closePromise = null;

  function signalFatal(reason) {
    if (reconnect.isStopped()) return;
    reconnect.stop();
    stream.stop();
    log(`sse stale endpoint (${reason}); signalling re-attach`);
    try {
      onFatal(reason);
    } catch {}
  }
  const stream = createNotifyStream({
    port,
    serverToken,
    getClientToken: () => clientToken,
    onNotify,
    log,
    onLoss: (reason) => reconnect.handleLoss(reason),
    onFatal: signalFatal,
    onStable: () => reconnect.resetBudget(),
  });
  const reconnect = createReconnectLoop({
    log,
    probeDaemon: registry.probeExpectedDaemon,
    reregister: registry.reregister,
    deregister: registry.deregister,
    getClientToken: () => clientToken,
    adoptClientToken: (token) => {
      clientToken = token;
    },
    openStream: stream.open,
    onFatal: signalFatal,
  });
  stream.open();

  const call = createChannelCall({ port, serverToken, agent: callAgent, getClientToken: () => clientToken });

  async function close(reason = 'client close', options = {}) {
    if (closePromise) return closePromise;
    // A re-register already in flight can mint a fresh token after close().
    // Await it so its stale branch deregisters that token before close resolves.
    const { pending, registrationId, replaceToken } = reconnect.stop();
    stream.stop();
    closePromise = (async () => {
      if (pending) await pending;
      await registry.deregister(clientToken, {
        registrationId,
        replaceToken,
        preserveRemoteIntent: options.preserveRemoteIntent === true,
      });
      callAgent.destroy();
      controlAgent.destroy();
      log(`detached (${reason})`);
    })();
    return closePromise;
  }

  return { call, close, clientToken, port };
}
