// Machine-global session daemon discovery, startup, transport and shutdown.
// createSession remains the stable public facade; its projection lives in
// session-proxy.mjs.
import http from 'node:http';
import path from 'node:path';
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
import { daemonCrashCaptureDir, daemonDataDir } from '../session-runtime/services/daemon-crash-capture.mjs';
import { forkDaemonCandidate } from '../session-runtime/services/daemon-candidate.mjs';
import { daemonOwnerIsStale, proveDaemonOwnerRecord } from './daemon-owner.mjs';
import { IN_TREE_DAEMON_STOP_GRACE_MS } from './daemon-stop-budget.mjs';
import { createAttachmentCalls } from './session-client/attachment-calls.mjs';
import { daemonUnavailableError } from './session-client/daemon-unavailable.mjs';
import { createLeaseHeartbeat } from './session-client/lease-heartbeat.mjs';
import { clampLeaseMs } from './session-transport/client-registry/client-grace.mjs';
import {
  EVENT_STREAM_LIVENESS_TIMEOUT_MS,
  EVENT_STREAM_RECONNECT_BASE_MS,
  EVENT_STREAM_RECONNECT_BUDGET_MS,
  EVENT_STREAM_RECONNECT_MAX_MS,
  createStreamLink,
} from './session-client/stream-link.mjs';
import { createSessionProxyFactory } from './session-proxy.mjs';

function daemonAgentFor(control, urgent) {
  if (control) return daemonControlAgent;
  return urgent ? daemonUrgentAgent : daemonCallAgent;
}

function sessionDiscoveryPath() {
  return path.join(resolveRuntimeRoot(), 'daemon.json');
}

function daemonOwnerPath() {
  return path.join(daemonDataDir(), 'daemon-owner.json');
}

function daemonEntry() {
  // ONE daemon: the channels/memory host also owns the session service, so both
  // spawn paths converge on the same singleton process.
  return fileURLToPath(new URL('./daemon.mjs', import.meta.url));
}

export function daemonShouldDetach({ platform = process.platform, processType = process.type } = {}) {
  // Keep the daemon in the packaged Desktop's Windows process tree so Task
  // Manager presents one Mixdog group. CLI/TUI launchers still detach the
  // machine-global daemon from their terminal lifetime.
  return !(platform === 'win32' && processType === 'browser');
}

// Data calls and lifecycle control must never share a socket pool. A burst of
// long /call requests can occupy every data socket; health/register/deregister
// still need a reserved lane so a new terminal can always attach or recover.
const daemonCallAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5_000,
  maxSockets: 64,
  maxFreeSockets: 8,
});
const daemonUrgentAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5_000,
  maxSockets: 8,
  maxFreeSockets: 2,
});
const daemonControlAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5_000,
  maxSockets: 4,
  maxFreeSockets: 2,
});
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
  // Total-duration bound (timeoutMs only measures socket inactivity, which a
  // trickling response keeps resetting). Probes set it; calls do not.
  deadlineMs = 0,
}) {
  return new Promise((settleResolve, settleReject) => {
    let deadlineTimer = null;
    const resolve = (value) => {
      clearTimeout(deadlineTimer);
      settleResolve(value);
    };
    const reject = (error) => {
      clearTimeout(deadlineTimer);
      settleReject(error);
    };
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        agent: daemonAgentFor(control, urgent),
        headers: {
          'X-Mixdog-Daemon-Token': token,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = null;
          }
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error(parsed?.error || data || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          resolve(parsed ?? {});
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(sessionTimeoutError(method, urlPath));
    });
    req.on('error', reject);
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        const error = sessionTimeoutError(method, urlPath);
        reject(error);
        req.destroy(error);
      }, deadlineMs);
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/** No answer within the request's bound: the daemon may be busy with it, not gone. */
function sessionTimeoutError(method, urlPath) {
  return Object.assign(new Error(`session timeout: ${method} ${urlPath}`), { code: 'ESESSIONTIMEOUT' });
}

/** /health within `timeoutMs` of total duration; null when it does not answer. */
export async function probeSessionHealth({ port, token, timeoutMs = 800 } = {}) {
  try {
    const health = await request({
      port,
      token,
      path: '/health',
      timeoutMs,
      deadlineMs: Math.max(1, timeoutMs),
      control: true,
    });
    return health?.status === 'ok' ? health : null;
  } catch {
    return null;
  }
}

/** Health probe + protocol compatibility against an explicit discovery,
 *  without reading daemon.json or spawning anything. `health` is null when
 *  the daemon does not answer (then `compatibility` is null too). */
export async function probeSessionCompatibility(discovery, { timeoutMs = 800, probeHealth = probeSessionHealth } = {}) {
  const health = await probeHealth({ port: discovery?.port, token: discovery?.token, timeoutMs });
  return { health, compatibility: health ? sessionDaemonCompatibility(health) : null };
}

export function readSessionDiscovery(discoveryPath = sessionDiscoveryPath()) {
  try {
    const parsed = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const endpoint = parsed?.endpoints?.session;
    const channel = parsed?.endpoints?.channel;
    const pid = parsed?.pid;
    if (!endpoint?.port || !endpoint?.token || !pid || !isPidAlive(pid)) return null;
    return {
      ...endpoint,
      pid,
      ...(channel?.port && channel?.token ? { channel: { port: channel.port, token: channel.token } } : {}),
    };
  } catch {}
  return null;
}

function positiveProtocol(value, fallback = 0) {
  const protocol = Number(value);
  return Number.isInteger(protocol) && protocol > 0 ? protocol : fallback;
}

/** Protocol generation, then API revision, then application build determines
 * ownership. An older client may attach to a newer daemon; a newer client
 * replaces an older daemon. Capability skew remains diagnostic only. */
export function sessionDaemonCompatibility(
  health,
  {
    protocol = SESSION_PROTOCOL,
    revision = SESSION_REVISION,
    version = runtimeVersion(),
    capabilityFingerprint = SESSION_CAPABILITY_FINGERPRINT,
  } = {}
) {
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

/** Ask the running daemon to yield to this build immediately, aborting its
 *  in-flight work. Resolves true when the request was accepted. */
export async function forceDaemonUpgrade({ log = () => {} } = {}) {
  const discovery = readSessionDiscovery();
  if (!discovery) return false;
  const result = await request({
    port: discovery.port,
    token: discovery.token,
    method: 'POST',
    path: '/upgrade',
    body: {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: runtimeVersion(),
      force: true,
    },
    timeoutMs: 3_000,
    control: true,
  });
  const accepted = result?.accepted === true;
  log(`forced daemon upgrade ${accepted ? 'accepted' : 'not accepted'}`);
  return accepted;
}

async function replaceLowerDaemon(discovery, initialHealth, { log, onUpgradeWait = null }) {
  const info = { fromVersion: initialHealth?.version, toVersion: runtimeVersion() };
  const notify = (state) => {
    try {
      onUpgradeWait?.({ state, ...info });
    } catch {
      // A throwing progress callback must not abort the upgrade wait.
    }
  };
  const done = () => {
    notify('done');
    return true;
  };
  const configuredTimeoutMs = Number(process.env.MIXDOG_DAEMON_UPGRADE_TIMEOUT_MS);
  // A stuck older daemon (a worker that never finishes draining) must not hang
  // every newer client forever: the wait is always bounded, and the caller
  // surfaces `daemonUpgradePending` instead of blocking indefinitely.
  // Infinity/NaN are NOT a configuration — they are the unbounded wait this
  // deadline exists to prevent, so they fall back to the default.
  const boundedTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
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
  log(`waiting for daemon build ${initialHealth?.version || 'unknown'}` + ` to yield to ${runtimeVersion()}`);
  notify('waiting');
  while (Date.now() < deadline) {
    const current = readSessionDiscovery();
    if (!current || Number(current.pid) !== Number(discovery.pid)) return done();
    const health = await probeSessionHealth({
      port: current.port,
      token: current.token,
      timeoutMs: 800,
    });
    if (!health || Number(health.pid) !== Number(discovery.pid)) return done();
    const compatibility = sessionDaemonCompatibility(health);
    if (compatibility.status === 'compatible' || compatibility.status === 'daemon-newer') return done();
    await delay(100);
  }
  const error = new Error('newer daemon build is still waiting for active work to finish');
  error.daemonUpgradePending = true;
  throw error;
}

/** Fork one daemon candidate DETACHED (it outlives this client — machine
 *  global) and resolve when it reports ready OR exits (race loss/crash); the
 *  caller then re-reads discovery and attaches to whoever won. The shared fork
 *  and crash capture live in ./daemon-candidate.mjs.
 *  `entry` is a test seam; production always forks the real daemon.
 *  `spawnEnv` (optional, async) supplies variables for this fork only, read
 *  at fork time: the desktop's system proxy. */
// Daemons this process forked into its own process tree (daemonShouldDetach
// false: the packaged Windows Desktop). Such a child is killed with its
// launcher (libuv's kill-on-close job), which skips its whole teardown —
// PostgreSQL stop included — so the launcher's quit stops it first.
const inTreeDaemons = new Map();

export async function spawnDaemonCandidate({ cwd, log, timeoutMs = 30_000, entry = daemonEntry(), spawnEnv = null }) {
  const extraEnv = spawnEnv ? await spawnEnv() : null;
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const detached = daemonShouldDetach();
  return forkDaemonCandidate({
    launcher: 'session-client',
    entry,
    cwd,
    // Inherit this launcher's flags (fork's default). withHeapCap('daemon')
    // adds --max-old-space-size only when MIXDOG_DAEMON_HEAP_MB is set.
    execArgv: withHeapCap('daemon', process.execArgv),
    spawnOptions: { detached, windowsHide: true },
    detached,
    env: {
      ...process.env,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: '1',
      MIXDOG_DAEMON_HOST: '1',
      MIXDOG_RUNTIME_ROOT: resolveRuntimeRoot(),
      // Session-only spawn: the daemon stays dormant on the channels side
      // until a channels client registers.
      MIXDOG_DAEMON_SPAWNED_FOR: 'session',
      MIXDOG_SUPERVISOR_PID: process.env.MIXDOG_SUPERVISOR_PID || String(process.pid),
    },
    log,
    timeoutMs,
    onForked: (child) => {
      const forkMs = at();
      child.once('spawn', () => {
        log(`daemon fork: forkMs=${forkMs} spawnEventMs=${at()}`);
        if (!detached && child.pid) {
          inTreeDaemons.set(child.pid, child);
          child.once('exit', () => inTreeDaemons.delete(child.pid));
        }
      });
    },
    onReady: () => log(`daemon ready at=${at()}ms`),
  });
}

/** Spawn-or-attach discovery for the machine-global daemon.
 *  `entry` and `proveOwner` are test seams; production always forks the real
 *  daemon and probes the real owner. */
export async function ensureDaemon({
  cwd = process.cwd(),
  log = () => {},
  attempts = 5,
  readyTimeoutMs = null,
  onUpgradeWait = null,
  entry = daemonEntry(),
  proveOwner = proveDaemonOwnerRecord,
  spawnEnv = null,
} = {}) {
  const configuredTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS);
  let requestedTimeoutMs = DEFAULT_DAEMON_READY_TIMEOUT_MS;
  if (Number.isFinite(Number(readyTimeoutMs)) && Number(readyTimeoutMs) > 0)
    requestedTimeoutMs = Number(readyTimeoutMs);
  else if (configuredTimeoutMs > 0) requestedTimeoutMs = configuredTimeoutMs;
  const timeoutMs = Math.max(1, requestedTimeoutMs);
  let deadline = Date.now() + timeoutMs;
  const maxSpawnAttempts = Math.max(0, Math.floor(Number(attempts) || 0));
  let spawnAttempts = 0;
  let waitingOwnerPid = 0;
  let waitingDrainPid = 0;
  let staleOwnerPid = 0;
  // What the passes observed, for the error when no endpoint ever appears.
  let unansweredDiscovery = null;
  let waitedOwner = null;
  let lastCandidate = null;
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
        timeoutMs: Math.max(1, Math.min(DAEMON_BOOT_PROBE_TIMEOUT_MS, deadline - Date.now())),
      });
      log(
        `discovery pid=${discovery.pid} port=${discovery.port}` +
          ` health=${health ? 'ok' : 'none'} probeMs=${Date.now() - probeStartedAt}` +
          ` at=${elapsed()}ms`
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
          await replaceLowerDaemon(discovery, health, { log, onUpgradeWait });
          // The older daemon's drain has its own bound; readiness of the
          // successor gets a fresh budget instead of the one the drain spent.
          deadline = Date.now() + timeoutMs;
          continue;
        }
        const err = new Error('daemon session protocol identity is invalid');
        err.sessionProtocolMismatch = true;
        throw err;
      }
      unansweredDiscovery = { pid: discovery.pid, port: discovery.port };
    }
    // A concurrent launcher can win the owner lock before it publishes
    // daemon.json. That is a healthy singleton boot, not a reason to spawn five
    // doomed contenders and report "endpoint unavailable" after ~500 ms. A
    // live pid whose heartbeat stopped is a reused pid (daemon-owner.mjs):
    // spawn, and the candidate reclaims it.
    // A live-pid record whose heartbeat looks stale (or that has none: v1.1.2
    // and older) is reclaimable only when its holder's endpoint does not
    // answer with its pid — a crashed daemon leaves its files behind, naming a
    // pid the OS may have reused. A probe cut short by this deadline proves
    // nothing either way.
    const proof = await proveOwner(daemonOwnerPath(), {
      discoveryPath: sessionDiscoveryPath(),
      budgetMs: Math.max(1, deadline - Date.now()),
    });
    const ownerState = readSingletonOwner(daemonOwnerPath(), {
      isStale: (owner) => daemonOwnerIsStale(owner, { proof }),
    });
    if (ownerState.stale && Number(ownerState.owner?.pid) !== staleOwnerPid) {
      staleOwnerPid = Number(ownerState.owner?.pid) || 0;
      log(
        `daemon owner record pid=${staleOwnerPid} heartbeatAt=${ownerState.owner?.heartbeatAt ?? '-'}` +
          ` probe=${proof?.verdict ?? '-'} is stale; spawning a daemon to reclaim it`
      );
    }
    const ownerPid = ownerState.alive ? Number(ownerState.owner?.pid) || 0 : 0;
    if (ownerPid) {
      waitedOwner = { pid: ownerPid, claimedAt: ownerState.owner?.claimedAt ?? null };
      if (ownerPid !== waitingOwnerPid) {
        waitingOwnerPid = ownerPid;
        log(`waiting for daemon owner pid=${ownerPid} to publish its session endpoint`);
      }
      await delay(Math.min(DAEMON_OWNER_POLL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    waitingOwnerPid = 0;
    waitedOwner = null;
    if (spawnAttempts >= maxSpawnAttempts) break;
    spawnAttempts += 1;
    log(`spawning daemon candidate attempt=${spawnAttempts} at=${elapsed()}ms`);
    lastCandidate = await spawnDaemonCandidate({
      cwd,
      log,
      timeoutMs: Math.max(1, deadline - Date.now()),
      entry,
      spawnEnv,
    });
  }
  throw daemonUnavailableError({
    discovery: unansweredDiscovery,
    owner: waitedOwner,
    candidate: lastCandidate?.summary?.() ?? null,
    spawnAttempts,
    maxSpawnAttempts,
    captureDir: daemonCrashCaptureDir(),
  });
}

/** Registers this client with the daemon. Transport failures are retried
 *  briefly; a 4xx is the daemon's verdict and is not. */
async function registerSessionClient({ port, serverToken, body }) {
  let registrationError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/client/register',
        body,
        timeoutMs: 3000,
        control: true,
      });
    } catch (error) {
      registrationError = error;
      if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) throw error;
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
  }
  throw registrationError || new Error('session registration failed');
}

/** Attach to a live daemon: register, open the frame stream, return a handle
 *  whose call() dispatches session operations. The stream and its recovery
 *  policy live under ./session-client/ (frame-stream, stream-reconnect). */
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
  remote = false,
  leaseMs = 30_000,
  heartbeatMs = 10_000,
  readDiscovery = remote ? () => discovery : () => readSessionDiscovery(),
  pidAlive = remote ? () => true : isPidAlive,
  probeHealth = probeSessionHealth,
  log = () => {},
} = {}) {
  if (!discovery?.port || !discovery?.token) throw new Error('daemon discovery {port, token} required');
  const { port, token: serverToken } = discovery;
  const reg = await registerSessionClient({
    port,
    serverToken,
    body: {
      // A remote client's process lives on another machine: no local pid.
      leadPid: remote ? 0 : leadPid,
      cwd,
      lifecycle: lifecycle !== false,
      clientKind: clientKind === 'desktop' ? 'desktop' : 'session',
      registrationId: String(registrationId || randomUUID()),
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      ...(remote ? { remote: true, leaseMs: clampLeaseMs(leaseMs) } : {}),
    },
  });
  const clientToken = reg?.token;
  if (!clientToken) throw new Error('session registration returned no client token');

  const link = createStreamLink({
    discovery,
    port,
    serverToken,
    clientToken,
    onFrame,
    onFatal,
    onDisconnect: onStreamDisconnect,
    onReconnect: onStreamReconnect,
    reconnectBaseMs: streamReconnectBaseMs,
    reconnectMaxMs: streamReconnectMaxMs,
    reconnectBudgetMs: streamReconnectBudgetMs,
    livenessTimeoutMs: streamLivenessTimeoutMs,
    readDiscovery,
    probeHealth,
    pidAlive,
    log,
  });
  link.open();
  const heartbeat = remote
    ? createLeaseHeartbeat({ request, port, serverToken, clientToken, heartbeatMs, leaseMs, log })
    : null;
  heartbeat?.start();
  const { call, close } = createAttachmentCalls({
    request,
    port,
    serverToken,
    clientToken,
    stopStream: link.stop,
    stopHeartbeat: heartbeat?.stop,
    log,
  });

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
export async function shutdownDaemon(
  discovery = readSessionDiscovery(),
  { waitForExit = false, timeoutMs = 15_000 } = {}
) {
  if (!discovery?.port) return false;
  const daemonPid = Number(discovery.pid);
  try {
    await request({
      port: discovery.port,
      token: discovery.token,
      method: 'POST',
      path: '/shutdown',
      body: {},
      timeoutMs: 3000,
      control: true,
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

/** Launcher quit: a daemon this process forked into its own tree would die
 *  with it, so ask the serving one to stop (forced — its work cannot outlive
 *  this tree anyway) and wait, bounded, for every such child's graceful exit.
 *  One that already unpublished its endpoint is mid-teardown: only waited on.
 *  False when no such child is alive (detached, or another launcher's). */
export async function stopInTreeDaemon({
  timeoutMs = IN_TREE_DAEMON_STOP_GRACE_MS,
  discovery = readSessionDiscovery(),
} = {}) {
  const pids = [...inTreeDaemons.keys()].filter((pid) => isPidAlive(pid));
  if (!pids.length) return false;
  if (discovery?.port && pids.includes(Number(discovery.pid))) {
    try {
      await request({
        port: discovery.port,
        token: discovery.token,
        method: 'POST',
        path: '/stop',
        body: { force: true },
        timeoutMs: 3000,
        control: true,
      });
    } catch {
      // Past its front door already: only the wait remains.
    }
  }
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || IN_TREE_DAEMON_STOP_GRACE_MS);
  while (pids.some((pid) => isPidAlive(pid)) && Date.now() < deadline) await delay(50);
  return !pids.some((pid) => isPidAlive(pid));
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
  forceDaemonUpgrade,
  closeIdleConnections: () => {
    daemonCallAgent.destroy();
    daemonUrgentAgent.destroy();
    daemonControlAgent.destroy();
  },
});
