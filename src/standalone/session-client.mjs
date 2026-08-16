// Session client: spawn-or-attach + the remote session proxy that both
// the terminal TUI and the desktop host consume in place of a local session
// runtime. The proxy keeps the store contract intact —
// getState() stays synchronous by mirroring the daemon's snapshot frames, and
// every other method is forwarded over the transport.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from './session-wire.mjs';
import {
  createSessionProtocolClient,
  SESSION_CONFIGURE_ACTIONS,
  SESSION_CONFIGURE_ACTION_SET,
  SESSION_READ_ACTIONS,
  SESSION_READ_ACTION_SET,
} from './session-protocol.mjs';
import { readSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';

function runtimeRoot() {
  return resolveRuntimeRoot();
}

export function sessionDiscoveryPath() {
  return path.join(runtimeRoot(), 'daemon.json');
}

function daemonOwnerPath() {
  const dataDir = process.env.MIXDOG_DATA_DIR
    ? path.resolve(process.env.MIXDOG_DATA_DIR)
    : path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
  return path.join(dataDir, 'daemon-owner.json');
}

function daemonEntry() {
  // ONE daemon: the channels/memory host also owns the session pool, so both
  // spawn paths converge on the same singleton process.
  return fileURLToPath(new URL('./daemon.mjs', import.meta.url));
}

export function daemonShouldDetach({
  platform = process.platform,
  processType = process.type,
} = {}) {
  // Keep the daemon in the packaged Desktop's Windows process tree so Task
  // Manager presents one Mixdog group. CLI/TUI launchers still detach the
  // machine-global daemon from their terminal lifetime.
  return !(platform === 'win32' && processType === 'browser');
}

// Data calls and lifecycle control must never share a socket pool. A burst of
// long /call requests can occupy every data socket; health/register/deregister
// still need a reserved lane so a new terminal can always attach or recover.
const daemonCallAgent = new http.Agent({
  keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 64, maxFreeSockets: 8,
});
const daemonUrgentAgent = new http.Agent({
  keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 8, maxFreeSockets: 2,
});
const daemonControlAgent = new http.Agent({
  keepAlive: true, keepAliveMsecs: 5_000, maxSockets: 4, maxFreeSockets: 2,
});
const URGENT_CALLS = new Set([
  'session.submit',
  'session.abort',
  'session.approve',
  'session.unsubscribe',
  'desktop.control',
  'desktop.unsubscribe',
]);
const EVENT_STREAM_RECONNECT_BASE_MS = 1_000;
const EVENT_STREAM_RECONNECT_MAX_MS = 30_000;
// Keepalive silence is detected independently
// from TCP close, and a continuously failing reconnect storm is bounded.
const EVENT_STREAM_LIVENESS_TIMEOUT_MS = 45_000;
const EVENT_STREAM_RECONNECT_BUDGET_MS = 10 * 60_000;
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DAEMON_OWNER_POLL_MS = 50;
// A daemon that restarted needs a moment to rebind its port, so one immediate
// re-attach often lands in the same gap the first call died in. Mirror the
// event-stream policy above with a short bounded ladder; `callId` keeps a
// retried submit idempotent on the daemon side, so replaying is safe.
const CALL_RECOVERY_BACKOFF_MS = Object.freeze([0, 150, 600]);

function request({
  port,
  token,
  method = 'GET',
  path: urlPath,
  body = null,
  timeoutMs = 120_000,
  control = false,
  urgent = false,
}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      agent: control ? daemonControlAgent : urgent ? daemonUrgentAgent : daemonCallAgent,
      headers: {
        'X-Mixdog-Daemon-Token': token,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = null; }
        if (res.statusCode && res.statusCode >= 400) {
          const err = new Error(parsed?.error || data || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(parsed ?? {});
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`session timeout: ${method} ${urlPath}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function probeSessionHealth({ port, token, timeoutMs = 800 } = {}) {
  try {
    const health = await request({ port, token, path: '/health', timeoutMs, control: true });
    return health?.status === 'ok' ? health : null;
  } catch { return null; }
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function readSessionDiscovery(discoveryPath = sessionDiscoveryPath()) {
  const readUnified = (candidate) => {
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    const endpoint = parsed?.endpoints?.session;
    const channel = parsed?.endpoints?.channel;
    const pid = parsed?.pid;
    if (!endpoint?.port || !endpoint?.token || !pid || !isPidAlive(pid)) return null;
    return {
      ...endpoint,
      pid,
      ...(channel?.port && channel?.token
        ? { channel: { port: channel.port, token: channel.token } }
        : {}),
    };
  };
  try { return readUnified(discoveryPath); } catch {}
  return null;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function positiveProtocol(value, fallback = 0) {
  const protocol = Number(value);
  return Number.isInteger(protocol) && protocol > 0 ? protocol : fallback;
}

/** Protocol generation, then API revision, then application build determines
 * ownership. An older client may attach to a newer daemon; a newer client
 * replaces an older daemon. Capability skew remains diagnostic only. */
export function sessionDaemonCompatibility(health, {
  protocol = SESSION_PROTOCOL,
  revision = SESSION_REVISION,
  version = runtimeVersion(),
  capabilityFingerprint = SESSION_CAPABILITY_FINGERPRINT,
} = {}) {
  const daemonProtocol = positiveProtocol(health?.protocol);
  if (!daemonProtocol) return { status: 'invalid', protocol: daemonProtocol };
  const daemonVersion = String(health?.version || '0.0.0');
  const daemonRevision = Math.max(0, Number(health?.revision) || 0);
  const details = {
    protocol: daemonProtocol,
    revision: daemonRevision,
    version: daemonVersion,
    capabilityMismatch: String(health?.capabilityFingerprint || '') !== capabilityFingerprint,
  };
  if (daemonProtocol !== protocol) return { status: 'protocol-mismatch', ...details };
  if (revision < daemonRevision) return { status: 'daemon-newer', ...details };
  if (revision > daemonRevision) return { status: 'client-newer', ...details };
  const versionOrder = compareRuntimeVersions(version, daemonVersion);
  if (versionOrder < 0) return { status: 'daemon-newer', ...details };
  if (versionOrder > 0) return { status: 'client-newer', ...details };
  return { status: 'compatible', ...details };
}

async function replaceLowerDaemon(discovery, initialHealth, { log }) {
  const configuredTimeoutMs = Number(process.env.MIXDOG_DAEMON_UPGRADE_TIMEOUT_MS);
  const deadline = configuredTimeoutMs > 0
    ? Date.now() + Math.max(10_000, configuredTimeoutMs)
    : Number.POSITIVE_INFINITY;
  const result = await request({
    port: discovery.port,
    token: discovery.token,
    method: 'POST',
    path: '/upgrade',
    body: {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: runtimeVersion(),
    },
    timeoutMs: 3_000,
    control: true,
  });
  if (result?.accepted !== true) throw new Error('daemon replacement was not accepted');
  log(
    `waiting for daemon build ${initialHealth?.version || 'unknown'}`
    + ` to yield to ${runtimeVersion()}`,
  );
  while (Date.now() < deadline) {
    const current = readSessionDiscovery();
    if (!current || Number(current.pid) !== Number(discovery.pid)) return true;
    const health = await probeSessionHealth({
      port: current.port,
      token: current.token,
      timeoutMs: 800,
    });
    if (!health || Number(health.pid) !== Number(discovery.pid)) return true;
    const compatibility = sessionDaemonCompatibility(health);
    if (compatibility.status === 'compatible' || compatibility.status === 'daemon-newer') return true;
    await delay(100);
  }
  const error = new Error('newer daemon build is still waiting for active work to finish');
  error.daemonUpgradePending = true;
  throw error;
}

/** Fork one daemon candidate DETACHED (it outlives this client — machine
 *  global) and resolve when it reports ready OR exits (race loss/crash); the
 *  caller then re-reads discovery and attaches to whoever won. */
function spawnDaemonCandidate({ cwd, log, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    let child;
    try {
      child = fork(daemonEntry(), [], {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        detached: daemonShouldDetach(),
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          MIXDOG_DAEMON_HOST: '1',
          MIXDOG_RUNTIME_ROOT: runtimeRoot(),
          // Session-only spawn: the daemon stays dormant on the channels side
          // until a channels client registers.
          MIXDOG_DAEMON_SPAWNED_FOR: 'session',
          MIXDOG_SUPERVISOR_PID: process.env.MIXDOG_SUPERVISOR_PID || String(process.pid),
        },
      });
    } catch (err) {
      log(`daemon spawn failed: ${err?.message || err}`);
      done();
      return;
    }
    const mirror = (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) log(text);
    };
    child.stderr?.on('data', mirror);
    child.once('message', (msg) => {
      if (msg?.type !== 'ready') return;
      try { child.stderr?.off?.('data', mirror); } catch {}
      try { child.disconnect?.(); } catch {}
      try { child.unref?.(); } catch {}
      try { child.stderr?.unref?.(); } catch {}
      done();
    });
    child.once('exit', done);
    child.once('error', (err) => { log(`daemon spawn error: ${err?.message || err}`); done(); });
    timer = setTimeout(done, Math.max(1, timeoutMs));
    timer.unref?.();
  });
}

/** Spawn-or-attach discovery for the machine-global daemon. */
export async function ensureDaemon({
  cwd = process.cwd(),
  log = () => {},
  attempts = 5,
  readyTimeoutMs = null,
} = {}) {
  const configuredTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS);
  const timeoutMs = Math.max(
    1,
    Number.isFinite(Number(readyTimeoutMs)) && Number(readyTimeoutMs) > 0
      ? Number(readyTimeoutMs)
      : configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : DEFAULT_DAEMON_READY_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const maxSpawnAttempts = Math.max(0, Math.floor(Number(attempts) || 0));
  let spawnAttempts = 0;
  let waitingOwnerPid = 0;
  while (Date.now() < deadline) {
    const discovery = readSessionDiscovery();
    if (discovery) {
      const health = await probeSessionHealth({ port: discovery.port, token: discovery.token });
      if (health && Number(health.pid) === Number(discovery.pid)) {
        const compatibility = sessionDaemonCompatibility(health);
        if (compatibility.status === 'compatible' || compatibility.status === 'daemon-newer') {
          return discovery;
        }
        if (compatibility.status === 'client-newer') {
          await replaceLowerDaemon(discovery, health, { log });
          continue;
        }
        const err = new Error('daemon session protocol identity is invalid');
        err.sessionProtocolMismatch = true;
        throw err;
      }
    }
    // A concurrent launcher can win the owner lock before it publishes
    // daemon.json. That is a healthy singleton boot, not a reason to spawn five
    // doomed contenders and report "endpoint unavailable" after ~500 ms.
    const ownerState = readSingletonOwner(daemonOwnerPath());
    const ownerPid = ownerState.alive ? Number(ownerState.owner?.pid) || 0 : 0;
    if (ownerPid) {
      if (ownerPid !== waitingOwnerPid) {
        waitingOwnerPid = ownerPid;
        log(`waiting for daemon owner pid=${ownerPid} to publish its session endpoint`);
      }
      await delay(Math.min(DAEMON_OWNER_POLL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    waitingOwnerPid = 0;
    if (spawnAttempts >= maxSpawnAttempts) break;
    spawnAttempts += 1;
    await spawnDaemonCandidate({
      cwd,
      log,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
  }
  throw new Error('daemon session endpoint is unavailable');
}

/** Attach to a live daemon: register, open the frame stream, return a handle
 *  whose call() dispatches session operations. */
export async function attachSession({
  discovery,
  leadPid = process.pid,
  cwd = process.cwd(),
  lifecycle = true,
  registrationId = randomUUID(),
  onFrame = () => {},
  onFatal = () => {},
  onStreamDisconnect = () => {},
  onStreamReconnect = () => {},
  streamReconnectBaseMs = EVENT_STREAM_RECONNECT_BASE_MS,
  streamReconnectMaxMs = EVENT_STREAM_RECONNECT_MAX_MS,
  streamLivenessTimeoutMs = EVENT_STREAM_LIVENESS_TIMEOUT_MS,
  streamReconnectBudgetMs = EVENT_STREAM_RECONNECT_BUDGET_MS,
  log = () => {},
} = {}) {
  if (!discovery?.port || !discovery?.token) throw new Error('daemon discovery {port, token} required');
  const { port, token: serverToken } = discovery;
  const stableRegistrationId = String(registrationId || randomUUID());
  let reg = null;
  let registrationError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      reg = await request({
        port, token: serverToken, method: 'POST', path: '/client/register',
        body: {
          leadPid,
          cwd,
          lifecycle: lifecycle !== false,
          registrationId: stableRegistrationId,
          protocol: SESSION_PROTOCOL,
          revision: SESSION_REVISION,
        },
        timeoutMs: 3000,
        control: true,
      });
      break;
    } catch (error) {
      registrationError = error;
      if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) throw error;
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
  }
  if (!reg) throw registrationError || new Error('session registration failed');
  const clientToken = reg?.token;
  if (!clientToken) throw new Error('session registration returned no client token');

  let closed = false;
  let streamRequest = null;
  let reconnectTimer = null;
  let streamLivenessTimer = null;
  let reconnectAttempt = 0;
  let disconnectedAt = 0;
  let lastLossReason = '';
  let streamWasReady = false;
  let fatalSignalled = false;
  const reconnectBaseMs = Math.max(1, Number(streamReconnectBaseMs) || EVENT_STREAM_RECONNECT_BASE_MS);
  const reconnectMaxMs = Math.max(
    reconnectBaseMs,
    Number(streamReconnectMaxMs) || EVENT_STREAM_RECONNECT_MAX_MS,
  );
  const livenessMs = Math.max(
    1,
    Number(streamLivenessTimeoutMs) || EVENT_STREAM_LIVENESS_TIMEOUT_MS,
  );
  const reconnectBudgetMs = Math.max(
    reconnectBaseMs,
    Number(streamReconnectBudgetMs) || EVENT_STREAM_RECONNECT_BUDGET_MS,
  );

  function clearStreamLiveness() {
    if (!streamLivenessTimer) return;
    clearTimeout(streamLivenessTimer);
    streamLivenessTimer = null;
  }

  function signalFatal(reason) {
    if (closed || fatalSignalled) return;
    fatalSignalled = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearStreamLiveness();
    const current = streamRequest;
    streamRequest = null;
    try { current?.destroy?.(); } catch {}
    try { onFatal(reason); } catch {}
  }

  function scheduleStreamReconnect(reason) {
    if (closed || fatalSignalled || reconnectTimer) return;
    clearStreamLiveness();
    const now = Date.now();
    if (!disconnectedAt) {
      disconnectedAt = now;
      lastLossReason = String(reason || 'sse disconnected');
      try { onStreamDisconnect({ reason: lastLossReason }); } catch {}
    }
    const downtimeMs = Math.max(0, now - disconnectedAt);
    if (downtimeMs >= reconnectBudgetMs) {
      signalFatal(`${lastLossReason}; reconnect budget exhausted after ${downtimeMs}ms`);
      return;
    }
    const attempt = reconnectAttempt + 1;
    reconnectAttempt = attempt;
    const delayMs = Math.min(
      reconnectBudgetMs - downtimeMs,
      reconnectMaxMs,
      reconnectBaseMs * (2 ** Math.min(attempt - 1, 8)),
    );
    log(`session event stream reconnecting attempt=${attempt} delayMs=${delayMs} reason=${lastLossReason}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void (async () => {
        if (closed || fatalSignalled) return;
        const downtimeMs = Math.max(0, Date.now() - disconnectedAt);
        if (downtimeMs >= reconnectBudgetMs) {
          signalFatal(`${lastLossReason}; reconnect budget exhausted after ${downtimeMs}ms`);
          return;
        }
        const current = readSessionDiscovery();
        const replaced = current
          && (
            Number(current.pid) !== Number(discovery.pid)
            || Number(current.port) !== Number(port)
            || String(current.token || '') !== String(serverToken)
          );
        if (replaced) {
          const health = await probeSessionHealth({
            port: current.port,
            token: current.token,
            timeoutMs: 800,
          });
          if (health && Number(health.pid) === Number(current.pid)) {
            signalFatal(
              `${lastLossReason}; daemon replaced`
              + ` oldPid=${Number(discovery.pid)} oldPort=${Number(port)}`
              + ` newPid=${Number(current.pid)} newPort=${Number(current.port)}`,
            );
            return;
          }
        }
        if (!isPidAlive(discovery.pid)) {
          signalFatal(
            `${lastLossReason}; daemon exited`
            + ` pid=${Number(discovery.pid)} port=${Number(port)}`,
          );
          return;
        }
        openStream();
      })().catch((error) => {
        log(`session event stream recovery probe failed: ${error?.message || error}`);
        openStream();
      });
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function openStream() {
    if (closed || fatalSignalled || streamRequest) return;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/events?token=${encodeURIComponent(clientToken)}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
    }, (res) => {
      if (req !== streamRequest || closed) { res.resume(); return; }
      if (res.statusCode !== 200) {
        res.resume();
        streamRequest = null;
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404) {
          signalFatal(`bad sse status ${res.statusCode}`);
        } else {
          scheduleStreamReconnect(`bad sse status ${res.statusCode}`);
        }
        return;
      }
      const reconnected = streamWasReady && disconnectedAt > 0;
      const reconnectInfo = reconnected ? {
        reason: lastLossReason,
        attempt: reconnectAttempt,
        downtimeMs: Math.max(0, Date.now() - disconnectedAt),
      } : null;
      res.setEncoding('utf8');
      let buffer = '';
      let streamHealthy = false;
      const markStreamHealthy = () => {
        if (streamHealthy) return;
        streamHealthy = true;
        streamWasReady = true;
        reconnectAttempt = 0;
        disconnectedAt = 0;
        lastLossReason = '';
        if (reconnectInfo) {
          log(
            `session event stream reconnected attempt=${reconnectInfo.attempt}`
            + ` downtimeMs=${reconnectInfo.downtimeMs}`,
          );
          try { onStreamReconnect(reconnectInfo); } catch {}
        }
      };
      let lossHandled = false;
      const lost = (reason) => {
        if (req !== streamRequest || closed) return;
        if (lossHandled) return;
        lossHandled = true;
        clearStreamLiveness();
        streamRequest = null;
        scheduleStreamReconnect(reason);
      };
      const armStreamLiveness = () => {
        clearStreamLiveness();
        streamLivenessTimer = setTimeout(() => {
          if (req !== streamRequest || closed || fatalSignalled) return;
          lost(`sse liveness timeout after ${livenessMs}ms`);
          try { req.destroy(new Error('session SSE liveness timeout')); } catch {}
        }, livenessMs);
        streamLivenessTimer.unref?.();
      };
      armStreamLiveness();
      res.on('data', (chunk) => {
        if (req !== streamRequest || closed) return;
        // Any bytes, including `: ka` comments, prove transport liveness.
        markStreamHealthy();
        armStreamLiveness();
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue; // ': ka' keepalives
            const json = line.slice(5).trim();
            if (!json) continue;
            let frame = null;
            try { frame = JSON.parse(json); } catch { continue; }
            try { onFrame(frame); } catch (err) { log(`onFrame threw: ${err?.message || err}`); }
          }
        }
      });
      res.on('end', () => lost('sse ended'));
      res.on('error', () => lost('sse error'));
      res.on('aborted', () => lost('sse aborted'));
      res.on('close', () => lost('sse closed'));
    });
    req.on('error', () => {
      if (req !== streamRequest || closed) return;
      streamRequest = null;
      scheduleStreamReconnect('sse request error');
    });
    streamRequest = req;
    req.end();
  }
  openStream();

  async function call(name, args = {}, { timeoutMs = 300_000, callId = null } = {}) {
    let out;
    try {
      out = await request({
        port, token: serverToken, method: 'POST', path: '/call',
        body: { token: clientToken, name, args: args || {}, ...(callId ? { callId } : {}) },
        timeoutMs,
        urgent: URGENT_CALLS.has(name),
      });
    } catch (err) {
      // Transport death (daemon restarted/unreachable) is recoverable by
      // re-attaching; a session error comes back as a 200 {error} envelope.
      err.daemonTransportError = true;
      throw err;
    }
    if (out && out.error) throw new Error(out.error);
    return out?.result;
  }

  async function close(reason = 'client close') {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearStreamLiveness();
    try { streamRequest?.destroy?.(); } catch {}
    try {
      await request({
        port, token: serverToken, method: 'POST', path: '/client/deregister',
        body: { token: clientToken }, timeoutMs: 1500, control: true,
      });
    } catch { /* the daemon sweep reaps us anyway */ }
    log(`detached (${reason})`);
  }

  return {
    call,
    close,
    clientToken,
    port,
    pid: Number(discovery.pid),
    protocol: Number(reg.protocol) || SESSION_PROTOCOL,
    revision: Math.max(0, Number(reg.revision) || 0),
  };
}

/** Ask a live daemon to exit. Used by dev/test teardown; normal clients just
 *  detach and let the client-grace shutdown fire. */
export async function shutdownDaemon(discovery = readSessionDiscovery()) {
  if (!discovery?.port) return false;
  try {
    await request({
      port: discovery.port, token: discovery.token, method: 'POST',
      path: '/shutdown', body: {}, timeoutMs: 3000, control: true,
    });
    return true;
  } catch { return false; }
}

// ── Shared per-process attachment ────────────────────────────────────────────
// Every session view in this process rides ONE attachment. Frames and calls are
// addressed only by durable sessionId; runtime handles never cross the wire.
let shared = null;

function addSessionView(views, sessionId, view) {
  let bucket = views.get(sessionId);
  if (!bucket) { bucket = new Set(); views.set(sessionId, bucket); }
  bucket.add(view);
}

function removeSessionView(views, sessionId, view) {
  const bucket = views.get(sessionId);
  if (!bucket) return;
  bucket.delete(view);
  if (bucket.size === 0) views.delete(sessionId);
}

function sessionViewCount(views, sessionId) {
  return views.get(sessionId)?.size ?? 0;
}

function applyStatePatch(state, patch) {
  const next = { ...state, ...(patch.set || {}) };
  if (patch.itemsAppend) {
    const base = Array.isArray(state.items) ? state.items : [];
    next.items = base.slice(0, patch.itemsAppend.from).concat(patch.itemsAppend.values || []);
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
}

const liveViews = new Set();
let reattachTimer = null;

function scheduleReattach({ cwd, log }) {
  if (reattachTimer || liveViews.size === 0) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    if (liveViews.size === 0) return;
    void ensureSharedAttachment({ cwd, log }).catch((err) => {
      log(`daemon re-attach failed: ${err?.message || err}`);
      scheduleReattach({ cwd, log });
    });
  }, 500);
  reattachTimer.unref?.();
}

async function ensureSharedAttachment({ cwd, log }) {
  if (shared?.client) return shared;
  if (shared?.pending) return shared.pending;
  const pending = (async () => {
    const discovery = await ensureDaemon({ cwd, log });
    const views = new Map();
    const state = { client: null, views, discovery, refs: liveViews.size, log, cwd };
    const attachmentOptions = {
      cwd,
      log,
      onFrame: (frame) => {
        const bucket = views.get(String(frame?.sessionId || ''));
        if (!bucket) return;
        for (const view of [...bucket]) {
          if (frame.type === 'session-state') view.applyFrame(frame, state);
          else if (frame.type === 'session-gone') view.applyGone(frame.reason || 'session unloaded');
        }
      },
      onFatal: (reason) => {
        log(`daemon attachment lost (${reason})`);
        if (shared === state) shared = null;
        for (const bucket of views.values()) {
          for (const view of [...bucket]) view.applyDetached(reason);
        }
        scheduleReattach({ cwd: state.cwd, log });
      },
    };
    const rawTransport = await attachSession({ discovery, ...attachmentOptions });
    state.client = createSessionProtocolClient(rawTransport);
    shared = state;
    for (const view of liveViews) {
      addSessionView(views, view.sessionId(), view);
      void view.recover(state).catch((err) => {
        log(`session ${view.sessionId()} recovery failed: ${err?.message || err}`);
      });
    }
    return state;
  })();
  shared = { pending };
  try {
    return await pending;
  } catch (err) {
    shared = null;
    throw err;
  }
}

/** Remote session projection backed by the daemon,
 *  while execution and durable intake stay in the daemon. */
export async function createSession(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cwd = options.cwd || process.cwd();
  const openParams = {
    cwd,
    provider: options.provider,
    model: options.model,
    toolMode: options.toolMode || 'full',
    remote: options.remote === true,
    desktopSession: options.desktopSession ?? null,
  };
  let attachment = await ensureSharedAttachment({ cwd, log });
  const created = await attachment.client.create(openParams, {
    callId: `session-create:${process.pid}:${randomUUID()}`,
  });
  let sessionId = String(created?.sessionId || '');
  if (!sessionId) throw new Error('session.create returned no sessionId');
  let state = created?.full ?? {};
  let revision = Number(created?.revision) || 0;
  // A revision belongs to one session projection on one daemon attachment. It
  // detects a missing patch on that stream; it is not session history and
  // never crosses a session rebind or daemon restart. This mirrors Codex
  // thread/resume: seed a full thread snapshot, then consume notifications
  // from the newly attached listener.
  let revisionAttachment = attachment;
  let revisionSessionId = sessionId;
  let reservedOnly = created?.reservedOnly === true;
  let disposed = false;
  const listeners = new Set();
  const resultAttachments = new WeakMap();

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (err) { log(`session listener threw: ${err?.message || err}`); }
    }
  }

  function applyBody(body, sourceAttachment = resultAttachments.get(body) || attachment) {
    if (disposed || !body) return false;
    // A response from the dead attachment may finish after recovery. It cannot
    // repaint the session that is now subscribed to a replacement daemon.
    if (sourceAttachment !== attachment) return true;
    if (Object.hasOwn(body, 'reservedOnly')) reservedOnly = body.reservedOnly === true;
    const incomingRevision = Number(body.revision);
    if (revisionAttachment !== sourceAttachment || revisionSessionId !== sessionId) {
      // A fresh attachment/session projection has no patch baseline. Only its
      // authoritative full snapshot may establish the new epoch; numeric
      // revisions from another projection are deliberately incomparable.
      if (body.full === undefined || body.full === null) return false;
      state = body.full;
      revision = Number.isFinite(incomingRevision) ? incomingRevision : 0;
      revisionAttachment = sourceAttachment;
      revisionSessionId = sessionId;
      emit();
      return true;
    }
    if (Number.isFinite(incomingRevision) && incomingRevision < revision) return true;
    if (body.full !== undefined && body.full !== null) {
      state = body.full;
      revision = Number.isFinite(incomingRevision) ? incomingRevision : revision;
      emit();
      return true;
    }
    if (body.patch) {
      // The daemon answers a state-changing call AND broadcasts the same step,
      // so every such call delivers one revision twice. Recognising the
      // duplicate as a no-op keeps it from looking like a revision gap, which
      // used to cost one extra full session.read per call.
      if (Number(body.revision) === revision
        && Number(body.baseRevision) === revision - 1) return true;
      if (Number(body.baseRevision) !== revision) return false;
      state = applyStatePatch(state, body.patch);
      revision = Number(body.revision) || revision;
      emit();
      return true;
    }
    if (Number.isFinite(Number(body.revision))) {
      revision = Number(body.revision);
      return true;
    }
    return false;
  }

  function baseRevisionFor(
    sourceAttachment = attachment,
    targetSessionId = sessionId,
  ) {
    return revisionAttachment === sourceAttachment && revisionSessionId === targetSessionId
      ? revision
      : null;
  }

  let resyncing = false;
  function resync(reason) {
    if (disposed || resyncing) return;
    resyncing = true;
    const requestAttachment = attachment;
    void requestAttachment.client.read({
      sessionId,
      open: openParams,
      baseRevision: baseRevisionFor(requestAttachment),
    }).then((result) => {
      if (disposed || requestAttachment !== attachment) return;
      if (result && typeof result === 'object') resultAttachments.set(result, requestAttachment);
      if (!applyBody(result, requestAttachment) && result?.revision !== undefined) {
        log(`session ${sessionId} resync returned an unusable body`);
      }
    }).catch((err) => {
      log(`session ${sessionId} resync after ${reason} failed: ${err?.message || err}`);
    }).finally(() => { resyncing = false; });
  }

  let recoveryPromise = null;
  let view;
  async function recover(nextAttachment) {
    if (disposed) return;
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const previousAttachment = attachment;
      if (previousAttachment !== nextAttachment) {
        removeSessionView(previousAttachment.views, sessionId, view);
        attachment = nextAttachment;
      }
      const recoveryAttachment = attachment;
      // Route notifications before asking the daemon to subscribe. The
      // session.subscribe response is the full baseline; frames racing after
      // server-side subscription are either full themselves or trigger a
      // baseline read, never disappear between the response and local wiring.
      addSessionView(recoveryAttachment.views, sessionId, view);
      revisionAttachment = null;
      revisionSessionId = '';
      let result;
      try {
        result = await recoveryAttachment.client.subscribe({
          sessionId, open: openParams, baseRevision: null,
        });
      } catch (error) {
        // A reserved New task has no durable transcript until its first
        // accepted submit. If the daemon dies before then, recreate the same
        // durable address instead of silently switching the pane to another
        // session. A submitted session always retries subscribe first so an
        // accepted-but-unacknowledged prompt can never be shadowed.
        if (!reservedOnly || !/session .* is not available/i.test(String(error?.message || error))) {
          throw error;
        }
        result = await recoveryAttachment.client.create({
          ...openParams,
          sessionId,
        }, {
          callId: `session-recover-reservation:${sessionId}`,
        });
      }
      if (disposed || recoveryAttachment !== attachment) return;
      if (result && typeof result === 'object') resultAttachments.set(result, recoveryAttachment);
      if (!applyBody(result, recoveryAttachment)) {
        const baseline = await recoveryAttachment.client.read({
          sessionId, open: openParams, baseRevision: null,
        });
        if (disposed || recoveryAttachment !== attachment) return;
        if (baseline && typeof baseline === 'object') {
          resultAttachments.set(baseline, recoveryAttachment);
        }
        if (!applyBody(baseline, recoveryAttachment)) {
          throw new Error(`session ${sessionId} recovery returned no full snapshot`);
        }
      }
      log(`session ${sessionId} projection recovered`);
    })();
    try {
      return await recoveryPromise;
    } finally {
      recoveryPromise = null;
    }
  }

  view = {
    sessionId: () => sessionId,
    applyFrame(frame, sourceAttachment = attachment) {
      if (disposed) return;
      if (!applyBody(frame, sourceAttachment)) resync('revision gap');
    },
    applyGone(reason) {
      if (disposed) return;
      log(`session ${sessionId} is no longer available (${reason})`);
    },
    applyDetached(reason) {
      log(`session ${sessionId} projection detached (${reason})`);
    },
    recover,
  };
  addSessionView(attachment.views, sessionId, view);
  attachment.refs += 1;
  liveViews.add(view);

  async function sendCall(route, payload, callId) {
    const send = async () => {
      const sourceAttachment = attachment;
      let result;
      if (route === 'session.create') result = await sourceAttachment.client.create(payload, { callId });
      else if (route === 'session.read') result = await sourceAttachment.client.read(payload, { callId });
      else if (route === 'session.subscribe') result = await sourceAttachment.client.subscribe(payload, { callId });
      else if (route === 'session.submit') result = await sourceAttachment.client.submit(payload, { callId });
      else if (route === 'session.abort') result = await sourceAttachment.client.abort(payload, { callId });
      else if (route === 'session.approve') result = await sourceAttachment.client.approve(payload, { callId });
      else if (route === 'session.configure') result = await sourceAttachment.client.configure(payload, { callId });
      else if (route === 'project.list') result = await sourceAttachment.client.projectList(payload, { callId });
      else if (route === 'project.inspect') result = await sourceAttachment.client.projectInspect(payload, { callId });
      else if (route === 'project.add') result = await sourceAttachment.client.projectAdd(payload, { callId });
      else if (route === 'project.touch') result = await sourceAttachment.client.projectTouch(payload, { callId });
      else if (route === 'project.rename') result = await sourceAttachment.client.projectRename(payload, { callId });
      else if (route === 'project.remove') result = await sourceAttachment.client.projectRemove(payload, { callId });
      else if (route === 'project.ensureDirectory') {
        result = await sourceAttachment.client.projectEnsureDirectory(payload, { callId });
      }
      else throw new TypeError(`session route ${route} is unavailable`);
      if (result && typeof result === 'object') {
        resultAttachments.set(result, sourceAttachment);
      }
      return result;
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (err) {
        const recoverable = err?.daemonTransportError
          || /unknown client token/i.test(String(err?.message || ''));
        if (!recoverable || disposed || attempt >= CALL_RECOVERY_BACKOFF_MS.length) throw err;
        const waitMs = CALL_RECOVERY_BACKOFF_MS[attempt];
        if (waitMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitMs); });
        if (disposed) throw err;
        if (shared === attachment) shared = null;
        const next = await ensureSharedAttachment({ cwd, log });
        await recover(next);
        if (attempt > 0) log(`session ${sessionId} call ${route} re-attached (attempt ${attempt + 1})`);
      }
    }
  }

  async function applyResult(result, reason) {
    const sourceAttachment = resultAttachments.get(result) || attachment;
    const nextSessionId = String(result?.sessionId || sessionId);
    if (nextSessionId && nextSessionId !== sessionId) {
      const previousSessionId = sessionId;
      addSessionView(attachment.views, nextSessionId, view);
      removeSessionView(attachment.views, previousSessionId, view);
      sessionId = nextSessionId;
    }
    if (!applyBody(result, sourceAttachment) && result?.revision !== undefined) {
      resync(`${reason} body gap`);
    }
    return result;
  }

  let transitionChain = Promise.resolve();
  function serializeTransition(task) {
    const run = transitionChain.then(task);
    transitionChain = run.then(() => {}, () => {});
    return run;
  }

  function remoteCall(method, args, callOptions = {}) {
    if (disposed) return Promise.reject(new Error('This session view is disposed.'));
    const route = SESSION_READ_ACTION_SET.has(method)
      ? 'session.read'
      : SESSION_CONFIGURE_ACTION_SET.has(method)
        ? 'session.configure'
        : null;
    if (!route) return Promise.reject(new TypeError(`session action ${method} is unavailable`));
    const targetSessionId = sessionId;
    const baseRevision = baseRevisionFor(attachment, targetSessionId);
    const stableCallId = typeof callOptions.callId === 'string' && callOptions.callId.trim()
      ? callOptions.callId.trim()
      : randomUUID();
    return sendCall(route, {
      sessionId: targetSessionId,
      action: method,
      args,
      open: openParams,
      baseRevision,
    }, stableCallId).then(async (result) => {
      if (!disposed && sessionId === targetSessionId) await applyResult(result, method);
      return result?.value ?? null;
    });
  }

  async function rebindTo(result, previousSessionId) {
    const nextSessionId = String(result?.sessionId || '');
    if (!nextSessionId) throw new Error('session route returned no sessionId');
    const lastLocalView = sessionViewCount(attachment.views, previousSessionId) <= 1;
    addSessionView(attachment.views, nextSessionId, view);
    removeSessionView(attachment.views, previousSessionId, view);
    sessionId = nextSessionId;
    if (!applyBody(result) && result?.revision !== undefined) resync('session rebind body gap');
    if (previousSessionId && previousSessionId !== nextSessionId && lastLocalView) {
      try {
        await attachment.client.unsubscribe({ sessionId: previousSessionId });
      } catch (err) {
        log(`session ${previousSessionId} unsubscribe failed: ${err?.message || err}`);
      }
    }
    return nextSessionId;
  }

  async function createReservedSession() {
    return serializeTransition(async () => {
      if (disposed) throw new Error('This session view is disposed.');
      const previousSessionId = sessionId;
      const result = await sendCall('session.create', openParams,
        `session-create:${process.pid}:${randomUUID()}`);
      return await rebindTo(result, previousSessionId);
    });
  }

  async function resumeSession(targetSessionId, resumeOptions) {
    const target = String(targetSessionId || '');
    if (!target) return false;
    return serializeTransition(async () => {
      if (disposed) throw new Error('This session view is disposed.');
      if (target === sessionId) {
        const result = await sendCall('session.read', {
          sessionId,
          open: openParams,
          baseRevision: baseRevisionFor(),
        }, randomUUID());
        await applyResult(result, 'resume');
        return true;
      }
      const previousSessionId = sessionId;
      const result = await sendCall('session.subscribe', {
        sessionId: target,
        open: { ...openParams, resumeOptions: resumeOptions || undefined },
        baseRevision: null,
      }, randomUUID());
      await rebindTo(result, previousSessionId);
      return true;
    });
  }

  let submitSeq = 0;
  async function submitAsync(prompt, options = {}) {
    if (disposed) throw new Error('This session view is disposed.');
    const submissionId = String(options?.id || '').trim()
      || `session-submit-${process.pid}-${Date.now()}-${(submitSeq += 1)}`;
    const targetSessionId = sessionId;
    const baseRevision = baseRevisionFor(attachment, targetSessionId);
    const result = await sendCall('session.submit', {
      sessionId: targetSessionId,
      prompt,
      options: { ...(options || {}), id: submissionId },
      open: openParams,
      baseRevision,
    }, `session-submit:${targetSessionId}:${submissionId}`);
    if (!disposed && sessionId === targetSessionId) await applyResult(result, 'submit');
    return result?.accepted === true;
  }

  async function abortAsync(options = {}) {
    if (disposed) return { aborted: false };
    const result = await sendCall('session.abort', {
      sessionId, open: openParams, options,
      baseRevision: baseRevisionFor(),
    }, randomUUID());
    return await applyResult(result, 'abort');
  }

  const base = {
    isRemoteSession: true,
    get disposedView() { return disposed; },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listSessions(options = {}) {
      const result = await attachment.client.list(options, { callId: randomUUID() });
      return Array.isArray(result?.sessions) ? result.sessions : [];
    },
    async listProjects() {
      const result = await sendCall('project.list', {}, randomUUID());
      return Array.isArray(result?.projects) ? result.projects : [];
    },
    async inspectProjectPath(projectPath) {
      return await sendCall('project.inspect', { path: projectPath }, randomUUID());
    },
    async addProject(projectPath) {
      const result = await sendCall('project.add', { path: projectPath }, randomUUID());
      return result?.project ?? null;
    },
    async touchProjectSelected(projectPath) {
      const result = await sendCall('project.touch', { path: projectPath }, randomUUID());
      return result?.project ?? null;
    },
    async renameProject(projectPath, name) {
      const result = await sendCall('project.rename', {
        path: projectPath,
        name,
      }, randomUUID());
      return result?.project ?? null;
    },
    async removeProject(projectPath) {
      const result = await sendCall('project.remove', { path: projectPath }, randomUUID());
      return result?.removed === true;
    },
    async ensureProjectDirectory(projectPath) {
      const result = await sendCall('project.ensureDirectory', {
        path: projectPath,
      }, randomUUID());
      return String(result?.path || '');
    },
    async newSession(options = {}) {
      // A newly-created daemon view already owns a durable reserved address.
      // New-task setup may ask for a fresh session before the first submit;
      // reusing that reservation avoids a second session.create round trip and
      // duplicate provider/session prewarm. Explicit route/workflow changes
      // omit this flag and retain the ordinary new-session boundary.
      if (options?.reuseReservation === true && reservedOnly) return true;
      await createReservedSession();
      return true;
    },
    resume: resumeSession,
    async prefetchSession(targetSessionId) {
      const target = String(targetSessionId || '');
      if (!target) return false;
      await attachment.client.read({
        sessionId: target,
        open: openParams,
        baseRevision: null,
      });
      return true;
    },
    submitAsync,
    submit(prompt, options) {
      if (disposed) return false;
      void submitAsync(prompt, options).catch((err) => {
        log(`session submit failed: ${err?.message || err}`);
      });
      return true;
    },
    abortAsync,
    abort(options = {}) {
      // Cancellation must bypass this view's ordered mutation chain. A slow
      // capability/read call ahead of it must never delay the user's ESC.
      void abortAsync(options).catch((err) => log(`session abort failed: ${err?.message || err}`));
      return true;
    },
    resolveToolApproval(id, decision) {
      // Approval unblocks a live turn and has the same priority requirement as
      // abort. Revision gaps caused by an overlapping ordinary call self-heal
      // through applyResult()/resync().
      void (async () => {
        if (disposed) return;
        const result = await sendCall('session.approve', {
          sessionId,
          approvalId: id,
          decision,
          open: openParams,
          baseRevision: baseRevisionFor(),
        }, randomUUID());
        await applyResult(result, 'approval');
      })().catch((err) => log(`session approval failed: ${err?.message || err}`));
      return true;
    },
    async dispose(reason = 'view dispose') {
      if (disposed) return;
      disposed = true;
      liveViews.delete(view);
      const releasedSessionId = sessionId;
      const lastLocalView = sessionViewCount(attachment.views, releasedSessionId) <= 1;
      if (lastLocalView) {
        try {
          await attachment.client.unsubscribe({ sessionId: releasedSessionId });
        } catch (err) {
          log(`session ${releasedSessionId} unsubscribe failed: ${err?.message || err}`);
        }
      }
      removeSessionView(attachment.views, releasedSessionId, view);
      listeners.clear();
      attachment.refs = Math.max(0, attachment.refs - 1);
      if (attachment.refs === 0 && liveViews.size === 0) {
        try { await attachment.client.close(reason); } catch {}
        // Last view gone: drop pooled keep-alive sockets so an idle connection
        // cannot keep the process (or a test runner) alive.
        try { daemonCallAgent.destroy(); } catch {}
        try { daemonUrgentAgent.destroy(); } catch {}
        try { daemonControlAgent.destroy(); } catch {}
        if (shared === attachment) shared = null;
      }
    },
  };

  for (const action of SESSION_READ_ACTIONS) {
    if (!Object.hasOwn(base, action)) base[action] = (...args) => remoteCall(action, args);
  }
  for (const action of SESSION_CONFIGURE_ACTIONS) {
    if (!Object.hasOwn(base, action)) base[action] = (...args) => remoteCall(action, args);
  }
  return base;
}
