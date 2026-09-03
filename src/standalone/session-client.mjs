// Machine-global session daemon discovery, startup, transport and shutdown.
// createSession remains the stable public facade; its projection lives in
// session-proxy.mjs.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sleep as delay } from '../runtime/shared/sleep.mjs';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from './session-wire.mjs';
import { readSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';
import { withHeapCap } from '../runtime/shared/heap-cap.mjs';
import { createSessionProxyFactory } from './session-proxy.mjs';

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
  // ONE daemon: the channels/memory host also owns the session service, so both
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
const DEFAULT_DAEMON_UPGRADE_TIMEOUT_MS = 120_000;
const DAEMON_OWNER_POLL_MS = 50;
const DAEMON_BOOT_PROBE_TIMEOUT_MS = 300;
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
  // A stuck older daemon (a worker that never finishes draining) must not hang
  // every newer client forever: the wait is always bounded, and the caller
  // surfaces `daemonUpgradePending` instead of blocking indefinitely.
  // Infinity/NaN are NOT a configuration — they are the unbounded wait this
  // deadline exists to prevent, so they fall back to the default.
  const boundedTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.max(10_000, configuredTimeoutMs)
    : DEFAULT_DAEMON_UPGRADE_TIMEOUT_MS;
  const deadline = Date.now() + boundedTimeoutMs;
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
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
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
        // Inherit this launcher's flags (fork's default) and add the daemon's
        // old-space cap on top: uncapped, a long-lived daemon stays resident
        // far above its live set.
        execArgv: withHeapCap('daemon', process.execArgv),
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
    const forkMs = at();
    child.once('spawn', () => { log(`daemon fork: forkMs=${forkMs} spawnEventMs=${at()}`); });
    let firstStderrMs = -1;
    const mirror = (chunk) => {
      if (firstStderrMs < 0) { firstStderrMs = at(); log(`daemon first stderr at=${firstStderrMs}ms`); }
      const text = String(chunk || '').trimEnd();
      if (text) log(text);
    };
    child.stderr?.on('data', mirror);
    child.once('message', (msg) => {
      if (msg?.type !== 'ready') return;
      log(`daemon ready at=${at()}ms`);
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
  let waitingDrainPid = 0;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  while (Date.now() < deadline) {
    const discovery = readSessionDiscovery();
    if (discovery) {
      // A live loopback daemon answers /health in single-digit milliseconds.
      // Only a daemon mid-teardown (port still bound, loop gone) exhausts the
      // timeout, and the desktop paid that wait on EVERY quick relaunch
      // (user: 부팅 속도). Keep it short: a wrong verdict only spawns one
      // contender, which loses the singleton claim and exits for attach.
      const probeStartedAt = Date.now();
      const health = await probeSessionHealth({
        port: discovery.port,
        token: discovery.token,
        timeoutMs: DAEMON_BOOT_PROBE_TIMEOUT_MS,
      });
      log(
        `discovery pid=${discovery.pid} port=${discovery.port}`
        + ` health=${health ? 'ok' : 'none'} probeMs=${Date.now() - probeStartedAt}`
        + ` at=${elapsed()}ms`,
      );
      if (health && Number(health.pid) === Number(discovery.pid)) {
        if (health.drainCommitted === true) {
          const drainPid = Number(discovery.pid) || 0;
          if (drainPid !== waitingDrainPid) {
            waitingDrainPid = drainPid;
            log(`waiting for committed daemon handoff pid=${drainPid}`);
          }
          await delay(Math.min(DAEMON_OWNER_POLL_MS, Math.max(1, deadline - Date.now())));
          continue;
        }
        waitingDrainPid = 0;
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
    log(`spawning daemon candidate attempt=${spawnAttempts} at=${elapsed()}ms`);
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
  clientKind = 'session',
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
          clientKind: clientKind === 'desktop' ? 'desktop' : 'session',
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
    if (out && out.error) {
      // Preserve the daemon's machine-readable classification across the wire.
      const err = new Error(out.error);
      if (out.code) err.code = String(out.code);
      throw err;
    }
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
export async function shutdownDaemon(discovery = readSessionDiscovery(), {
  waitForExit = false,
  timeoutMs = 15_000,
} = {}) {
  if (!discovery?.port) return false;
  const daemonPid = Number(discovery.pid);
  try {
    await request({
      port: discovery.port, token: discovery.token, method: 'POST',
      path: '/shutdown', body: {}, timeoutMs: 3000, control: true,
    });
  } catch {
    return Number.isInteger(daemonPid) && daemonPid > 0 && !isPidAlive(daemonPid);
  }
  if (!waitForExit || !Number.isInteger(daemonPid) || daemonPid <= 0) return true;
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 15_000);
  while (isPidAlive(daemonPid) && Date.now() < deadline) await delay(50);
  if (isPidAlive(daemonPid)) {
    throw new Error(`session daemon pid=${daemonPid} did not exit within ${timeoutMs}ms`);
  }
  return true;
}

export async function shutdownDaemonForRuntimeRoot(root, options = {}) {
  const runtimeRoot = String(root || '').trim();
  if (!runtimeRoot) return false;
  const discovery = readSessionDiscovery(path.join(path.resolve(runtimeRoot), 'daemon.json'));
  if (!discovery) return false;
  return shutdownDaemon(discovery, options);
}

/** Remote session projection backed by the daemon,
 *  while execution and durable intake stay in the daemon. */
export const createSession = createSessionProxyFactory({
  attachSession,
  ensureDaemon,
  closeIdleConnections: () => {
    daemonCallAgent.destroy();
    daemonUrgentAgent.destroy();
    daemonControlAgent.destroy();
  },
});
