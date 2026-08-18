// Machine-global Mixdog daemon entry — one process for sessions, channels, and memory.
//
// One process per machine hosts the whole service: the channels runtime
// (worker-main), the memory runtime, and the session runtime pool. It exposes
// two local front doors — channel transport (pointer-routed calls) and session
// transport (broadcast session frames) — so the
// terminal TUI and the desktop app are views over ONE writer instead of each
// booting a separate service and arbitrating ownership on disk.
// Spawned (or attached-to) by createStandaloneChannelWorker; ownership is a
// pid-verified singleton lock (singleton-owner.mjs) — NOT the try-once
// active-instance lock that starved under 6 contending workers. A stale daemon
// (dead owner pid) is reclaimed by the next claim; a live peer that wins the
// race makes this process exit(0) so the spawner attaches to the winner.
//
// The unified host identity is set before the channels runtime is loaded so
// worker-main skips its parent-IPC loop and this entry owns start()/stop().
process.env.MIXDOG_WORKER_MODE = process.env.MIXDOG_WORKER_MODE || '1';
// This process owns session runtimes and must never proxy back into itself.
process.env.MIXDOG_DAEMON_HOST = '1';
// Size the libuv threadpool before any async fs work spins it up (see
// uv-threadpool-boot.mjs) — imports below already touch fs.
await import('../runtime/shared/uv-threadpool-boot.mjs');

// V8 compile cache: the daemon is a standalone child entry (not via cli.mjs);
// caching compiled bytecode across restarts removes the channels+memory
// runtime parse cost from every daemon boot. Best-effort.
try {
  const { enableCompileCache } = await import('node:module');
  enableCompileCache?.();
} catch { /* launch-speed optimization only */ }

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';
import { claimSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';
import { setChannelNotifySink } from '../runtime/channels/lib/parent-bridge.mjs';
import { setOwnerContext } from '../runtime/channels/lib/runtime-paths.mjs';
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { resourceAdmission } from '../runtime/shared/resource-admission.mjs';
import { snapshot as childSpawnSnapshot } from '../runtime/shared/child-spawn-gate.mjs';
import { toolWorkloadSnapshot } from '../runtime/shared/tool-workload-gates.mjs';
import { providerAdmissionScheduler } from '../runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import { getMcpAdmissionSnapshot } from '../runtime/agent/orchestrator/mcp/client.mjs';
import { loadConfig as loadAgentConfig } from '../runtime/agent/orchestrator/config.mjs';
import { initProviders } from '../runtime/agent/orchestrator/providers/registry.mjs';
import { makeAgentDispatch } from '../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import {
  closeProviderStreamJsonPool,
  providerStreamJsonSnapshot,
} from '../runtime/agent/orchestrator/providers/stream-json-pool.mjs';
import { createAgentDispatchBroker } from './agent-dispatch-broker.mjs';
import { createChannelTransport } from './channel-transport.mjs';
import { createChannelSessionRouter } from './channel-session-router.mjs';
import { createSessionTransport } from './session-transport.mjs';
import { createSessionService } from './session-service.mjs';
import { createSessionProtocolClient } from './session-protocol.mjs';
import { createSessionRuntimePool } from './session-runtime-pool.mjs';
import { getStandaloneMemoryRuntime } from './memory-runtime-proxy.mjs';
import {
  compareRuntimeVersions,
  SESSION_CAPABILITY_FINGERPRINT,
  SESSION_PROTOCOL,
  SESSION_REVISION,
  runtimeVersion,
} from './session-wire.mjs';

ensureProcessListenerHeadroom(64);

const RUNTIME_ROOT = resolveRuntimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR
  ? path.resolve(process.env.MIXDOG_DATA_DIR)
  : path.join(process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
process.env.MIXDOG_DATA_DIR = DATA_DIR;
process.env.MIXDOG_SERVER_PID = String(process.pid);
const CWD = process.cwd();
const DAEMON_DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'daemon.json');
// Owner-election lock, separate from the channels seat/bridge state.
const OWNER_PATH = path.join(DATA_DIR, 'daemon-owner.json');
const MEMORY_ENTRY = fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url));
// The spawning TUI mirrors our stderr into this file ONLY until it sees our
// 'ready' message; after that its pipe consumer dies on parent exit and later
// lines would be lost. So once ready we append here ourselves (fileLogging on),
// keyed to the SAME ready event the spawner detaches on — no loss, no dup.
const LOG_PATH = path.join(DATA_DIR, 'daemon.log');
let fileLogging = false;
// This process outlives every spawner, so it has to bound its OWN log: the
// spawner's boot-time rotate never runs again while the daemon lives, and the
// redirect below sends every hosted module's stderr here too.
const LOG_LINE_MAX_CHARS = 16_384;
const LOG_QUEUE_MAX_BYTES = 512 * 1024;
let logQueue = [];
let logQueueBytes = 0;
let logDropped = 0;
let logFlushTimer = null;
let logWriter = Promise.resolve();
let logFileBytes = null;

function boundedLogText(value) {
  const text = String(value ?? '');
  if (text.length <= LOG_LINE_MAX_CHARS) return text;
  return `${text.slice(0, LOG_LINE_MAX_CHARS)}… [truncated ${text.length - LOG_LINE_MAX_CHARS} chars]`;
}

async function rotateDaemonLogIfNeeded(incomingBytes) {
  if (logFileBytes === null) {
    try { logFileBytes = (await stat(LOG_PATH)).size; }
    catch { logFileBytes = 0; }
  }
  if (logFileBytes + incomingBytes <= PLUGIN_LOG_MAX_BYTES) return;
  const keep = Math.min(logFileBytes, PLUGIN_LOG_KEEP_BYTES);
  const tail = Buffer.allocUnsafe(keep);
  const handle = await open(LOG_PATH, 'r');
  try {
    const { bytesRead } = await handle.read(tail, 0, keep, Math.max(0, logFileBytes - keep));
    await writeFile(LOG_PATH, tail.subarray(0, bytesRead));
    logFileBytes = bytesRead;
  } finally {
    await handle.close().catch(() => {});
  }
}

function takeLogBatch() {
  if (logQueue.length === 0 && logDropped === 0) return '';
  const dropped = logDropped;
  const rows = logQueue;
  logQueue = [];
  logQueueBytes = 0;
  logDropped = 0;
  if (dropped > 0) {
    rows.unshift(`[${new Date().toISOString()}] [daemon] dropped ${dropped} log line(s) under backpressure\n`);
  }
  return rows.join('');
}

function queueLogFlush(delayMs = 10) {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const batch = takeLogBatch();
    if (!batch) return;
    logWriter = logWriter.then(async () => {
      await mkdir(path.dirname(LOG_PATH), { recursive: true });
      await rotateDaemonLogIfNeeded(Buffer.byteLength(batch));
      await appendFile(LOG_PATH, batch, 'utf8');
      logFileBytes = (logFileBytes || 0) + Buffer.byteLength(batch);
    }).catch(() => {});
    if (logQueue.length > 0 || logDropped > 0) queueLogFlush();
  }, delayMs);
  logFlushTimer.unref?.();
}

function appendDaemonLog(text) {
  const line = `[${new Date().toISOString()}] ${boundedLogText(text)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > LOG_QUEUE_MAX_BYTES || logQueueBytes + bytes > LOG_QUEUE_MAX_BYTES) {
    logDropped += 1;
    queueLogFlush();
    return;
  }
  logQueue.push(line);
  logQueueBytes += bytes;
  queueLogFlush();
}

async function flushDaemonLogs() {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  const batch = takeLogBatch();
  if (batch) {
    logWriter = logWriter.then(async () => {
      await mkdir(path.dirname(LOG_PATH), { recursive: true });
      await rotateDaemonLogIfNeeded(Buffer.byteLength(batch));
      await appendFile(LOG_PATH, batch, 'utf8');
      logFileBytes = (logFileBytes || 0) + Buffer.byteLength(batch);
    }).catch(() => {});
  }
  await logWriter;
}
function log(line) {
  const text = `[daemon] ${line}`;
  // Exactly ONE sink per line: before ready the spawner mirrors our stderr into
  // the log, so write stderr only; after ready we own the file, so write the
  // file only — never both (no duplicate around the ready handoff).
  if (!fileLogging) {
    try { process.stderr.write(`${text}\n`); } catch {}
    return;
  }
  appendDaemonLog(text);
}

// Redirect raw process.stderr/stdout writes and console.* from ANY module in
// this process to the daemon log file. Installed at the ready boundary (same
// point fileLogging flips) so pre-ready lines still reach the spawner mirror.
function installDaemonLogRedirect() {
  if (process.env.MIXDOG_DAEMON_ALLOW_STDERR === '1') return;
  const file = (chunk) => {
    const text = String(chunk ?? '').trimEnd();
    if (text) appendDaemonLog(text);
  };
  const patch = (stream) => {
    stream.write = ((chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      file(chunk);
      if (typeof done === 'function') { try { done(); } catch {} }
      return true;
    });
  };
  patch(process.stderr);
  patch(process.stdout);
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[m] = (...args) => file(`[console.${m}] ${args.map((a) =>
      typeof a === 'string'
        ? boundedLogText(a)
        : boundedLogText(inspect(a, {
          depth: 4,
          maxArrayLength: 50,
          maxStringLength: 4_096,
          breakLength: Infinity,
          compact: true,
        }))).join(' ')}`);
  }
}

let channels = null;
let transport = null;
let sessionTransport = null;
let sessionService = null;
let sessionRuntimePool = null;
let localSessionBridge = null;
let memoryRuntime = null;
let agentDispatchBroker = null;
let remoteSessionState = { enabled: false, sessionId: null };
let shuttingDown = false;
let shutdownRecheckTimer = null;
let replacementRequested = null;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let eventLoopLagTimer = null;

function startMemoryRuntimeEarly() {
  // Start the isolated memory process immediately after singleton ownership is
  // established. Do not await it: daemon front-door readiness remains
  // independent while PG/embedding cold-start overlaps all other boot work.
  if (process.env.MIXDOG_DAEMON_SKIP_MEMORY === '1') {
    log('memory runtime skipped (MIXDOG_DAEMON_SKIP_MEMORY=1)');
    return;
  }
  if (memoryRuntime) return;
  try {
    memoryRuntime = getStandaloneMemoryRuntime({
      entry: MEMORY_ENTRY,
      dataDir: DATA_DIR,
      cwd: CWD,
    });
    void memoryRuntime.init()
      .then(() => log('memory runtime ready in isolated process'))
      .catch((e) => log(`memory.start failed (non-fatal): ${e?.message || e}`));
  } catch (e) { log(`memory.start setup failed (non-fatal): ${e?.message || e}`); }
}

function eventLoopStatus() {
  const milliseconds = (value) => Number.isFinite(value) ? Math.round(value / 1e6) : 0;
  return {
    eventLoopP95Ms: milliseconds(eventLoopDelay.percentile(95)),
    eventLoopP99Ms: milliseconds(eventLoopDelay.percentile(99)),
    eventLoopMaxMs: milliseconds(eventLoopDelay.max),
  };
}

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (shutdownRecheckTimer) {
    clearTimeout(shutdownRecheckTimer);
    shutdownRecheckTimer = null;
  }
  log(`shutting down (${reason})`);
  try { setChannelNotifySink(null); } catch {}
  try { await sessionService?.stop?.(reason); } catch (e) { log(`session service stop failed: ${e?.message || e}`); }
  try { await sessionRuntimePool?.close?.(reason); } catch (e) { log(`session shard pool stop failed: ${e?.message || e}`); }
  try { await localSessionBridge?.close?.(reason); } catch (e) { log(`local session bridge.close failed: ${e?.message || e}`); }
  try { await sessionTransport?.stop?.(); } catch (e) { log(`session transport stop failed: ${e?.message || e}`); }
  try { await channels?.stop?.(); } catch (e) { log(`channels.stop failed: ${e?.message || e}`); }
  // The daemon only releases its client registration. The isolated memory
  // process shuts down after its last live client disappears.
  try { await memoryRuntime?.stop?.(); } catch (e) { log(`memory.stop failed: ${e?.message || e}`); }
  try { agentDispatchBroker?.close?.(reason); } catch (e) { log(`agent broker stop failed: ${e?.message || e}`); }
  try { await closeProviderStreamJsonPool(reason); } catch (e) { log(`stream parser stop failed: ${e?.message || e}`); }
  try { await transport?.stop?.(); } catch (e) { log(`transport.stop failed: ${e?.message || e}`); }
  if (eventLoopLagTimer) { clearInterval(eventLoopLagTimer); eventLoopLagTimer = null; }
  eventLoopDelay.disable();
  for (const discoveryPath of [DAEMON_DISCOVERY_PATH]) {
    try { rmSync(discoveryPath, { force: true }); } catch {}
  }
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  await flushDaemonLogs();
  process.exit(code);
}

/** One process, two front doors (channels + sessions): an idle side must never
 *  evict a busy one, so every self-shutdown trigger checks BOTH registries. */
let _lastDeferredLog = { key: '', at: 0, suppressed: 0 };
function maybeSelfShutdown(reason) {
  const channelClients = transport?.clientCount ?? 0;
  const sessionClients = sessionTransport?.clientCount ?? 0;
  const remoteClients = sessionService?.externalClientCount ?? 0;
  const replacing = Boolean(replacementRequested);
  if (channelClients > 0 || sessionClients > 0 || (!replacing && remoteClients > 0)) {
    if (shutdownRecheckTimer) {
      clearTimeout(shutdownRecheckTimer);
      shutdownRecheckTimer = null;
    }
    // Identical defers repeat for hours while one front door stays occupied;
    // log the first occurrence, then one summary line per minute.
    const deferKey = `${reason}|${channelClients}|${sessionClients}|${remoteClients}`;
    const now = Date.now();
    if (deferKey === _lastDeferredLog.key && now - _lastDeferredLog.at < 60_000) {
      _lastDeferredLog.suppressed += 1;
    } else {
      const suffix = _lastDeferredLog.suppressed > 0
        ? ` (+${_lastDeferredLog.suppressed} identical defers suppressed)`
        : '';
      log(`shutdown deferred (${reason}): channels=${channelClients} sessionClients=${sessionClients} remote=${remoteClients}${suffix}`);
      _lastDeferredLog = { key: deferKey, at: now, suppressed: 0 };
    }
    return;
  }
  const activeCalls = (transport?.activeCount ?? 0) + (sessionTransport?.activeCount ?? 0);
  const queuedCalls = (transport?.queuedCount ?? 0) + (sessionTransport?.queuedCount ?? 0);
  if (activeCalls > 0 || queuedCalls > 0) {
    log(`shutdown deferred (${reason}): activeCalls=${activeCalls} queuedCalls=${queuedCalls}`);
    if (!shutdownRecheckTimer) {
      shutdownRecheckTimer = setTimeout(() => {
        shutdownRecheckTimer = null;
        maybeSelfShutdown('service calls settled');
      }, 250);
      shutdownRecheckTimer.unref?.();
    }
    return;
  }
  // A turn in flight outlives every view — closing the app or the terminal is
  // not a reason to abandon work the daemon is still running.
  const busySessions = sessionService?.busyCount ?? 0;
  const busyMemoryAgents = agentDispatchBroker?.snapshot?.().inFlight ?? 0;
  if (busySessions > 0 || busyMemoryAgents > 0) {
    log(
      `shutdown deferred (${reason}): busySessions=${busySessions}`
      + ` memoryAgents=${busyMemoryAgents}`,
    );
    if (!shutdownRecheckTimer) {
      shutdownRecheckTimer = setTimeout(() => {
        shutdownRecheckTimer = null;
        maybeSelfShutdown('busy service work settled');
      }, 1_000);
      shutdownRecheckTimer.unref?.();
    }
    return;
  }
  void shutdown(reason);
}

function requestDaemonReplacement({ protocol, revision, version } = {}) {
  const requested = {
    protocol: Number(protocol),
    revision: Math.max(0, Number(revision) || 0),
    version: String(version || '0.0.0'),
  };
  if (requested.protocol !== SESSION_PROTOCOL) return false;
  const revisionOrder = requested.revision - SESSION_REVISION;
  const versionOrder = compareRuntimeVersions(requested.version, runtimeVersion());
  if (revisionOrder < 0 || (revisionOrder === 0 && versionOrder <= 0)) return false;
  if (
    replacementRequested
    && requested.revision === replacementRequested.revision
    && requested.version === replacementRequested.version
  ) return true;
  replacementRequested = requested;
  const reason = `daemon replacement by revision/build ${requested.revision}/${requested.version}`;
  log(`${reason} requested — draining clients without interrupting live work`);
  sessionTransport?.beginDrain?.(reason);
  transport?.beginDrain?.(reason);
  maybeSelfShutdown(reason);
  return true;
}

async function main() {
  const startedAt = performance.now();
  // The discovery file carries both privileged loopback tokens. POSIX roots
  // are per-user and fail closed if another account owns the configured path.
  ensurePrivateRuntimeRoot(RUNTIME_ROOT);

  // Pid-verified singleton claim (claimSingletonOwner reclaims a dead-pid owner
  // file and refuses only a LIVE peer). Loser exits so the spawner attaches to
  // the winner instead of running a second daemon.
  const claim = claimSingletonOwner(OWNER_PATH, {
    kind: 'mixdog-daemon',
    pid: process.pid,
    meta: {
      cwd: CWD,
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: runtimeVersion(),
    },
  });
  if (!claim.owned) {
    log(`live peer holds owner lock (pid=${claim.owner?.pid}) — exiting for attach`);
    process.exit(0);
  }
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });
  startMemoryRuntimeEarly();
  agentDispatchBroker = createAgentDispatchBroker({
    loadConfig: loadAgentConfig,
    initProviders,
    makeAgentDispatch,
    log,
    onActivityChanged: () => { maybeSelfShutdown('memory agent activity changed'); },
  });
  process.on('mixdog:turn-timing', (row = {}) => {
    const ms = (value) => Number.isFinite(value) ? Math.round(value) : -1;
    log(
      `turn timing status=${row.status || 'unknown'} session=${row.sessionId || '-'}`
      + ` e2e=${ms(row.endToEndTtftMs)}ms runtime=${ms(row.ttftMs)}ms`
      + ` queue=${ms(row.queueMs)}ms route=${ms(row.routeMs)}ms`
      + ` preflight=${ms(row.preflightMs)}ms mcp=${ms(row.mcpMs)}ms`
      + ` provider=${ms(row.providerMs)}ms`,
    );
  });

  // The channels runtime is imported AFTER the daemon env is set so worker-main
  // skips runWorkerIpc; that import also triggers its boot side effects
  // (config/service). It is now deferred past the ready handshake: a session
  // view attaching to this same process must not wait out the channels graph,
  // and every channels call awaits this promise anyway.
  let channelsReady = null;
  function ensureChannels() {
    if (!channelsReady) {
      channelsReady = import('../runtime/channels/index.mjs').then((module) => {
        channels = module;
        return module;
      });
    }
    return channelsReady;
  }

  // Channels bring automation with them (schedules, webhook listener + tunnel,
  // optional messaging service). A daemon spawned by a TUI starts them exactly
  // as before; a daemon spawned for session views stays dormant until a channels
  // client actually registers, so an app-only service runs no tunnels.
  let channelsStartPromise = null;
  function startChannels(options = {}) {
    if (channelsStartPromise) return channelsStartPromise;
    const messaging = options.messaging === true;
    channelsStartPromise = ensureChannels()
      .then((module) => module.start({ messaging }))
      .catch((e) => {
        channelsStartPromise = null;
        log(`channels.start failed (non-fatal): ${e?.message || e}`);
        throw e;
      });
    return channelsStartPromise;
  }

  // Accepted owner controls refresh active-instance context. The transport
  // admits rebind only for the current manual owner.
  const POINTER_TOOLS = new Set(['activate_channel_bridge', 'rebind_current_transcript']);
  const handleCall = async (name, args, ctx) => {
    const module = await ensureChannels();
    if (ctx && POINTER_TOOLS.has(name)) {
      try { setOwnerContext({ leadPid: ctx.leadPid, cwd: ctx.cwd }); } catch {}
    }
    return module.handleToolCallWithBridgeRetry(name, args || {});
  };
  transport = createChannelTransport({
    handleCall,
    agentBroker: agentDispatchBroker,
    log,
    // Self-shutdown when the last attached TUI leaves (reuses the SSE/client
    // registry as the liveness signal).
    onClientsEmpty: () => { maybeSelfShutdown('no live channel clients'); },
    // First channels client in: bring the channels runtime up (see startChannels).
    onClientRegistered: () => { startChannels(); },
  });
  const routeChannelNotification = createChannelSessionRouter({
    getSessionService: () => sessionService,
    // Channel-remote session pinning is retired; route by discovery only.
    getSessionId: () => null,
    log,
  });
  setChannelNotifySink((method, params) => {
    if (routeChannelNotification(method, params)) return;
    transport.notify(method, params);
  });
  const { port, token } = await transport.start();
  // Memory-cycle agent dispatch is rare and initializes on first use. Eagerly
  // loading its provider graph here consumed the control loop before any
  // memory cycle requested it.

  // ── Session front door ──────────────────────────────────────────────────────
  // Session runtimes live in child-process shards. The daemon owns routing and
  // fan-out only, so one provider/parser turn cannot stall health or input for
  // every other session.
  const localSessionClients = new Map();
  let nextLocalSessionClient = 0;
  localSessionBridge = {
    attach({ onFrame = () => {}, onFatal = () => {} } = {}) {
      const clientToken = `daemon_local_${process.pid}_${++nextLocalSessionClient}`;
      let closed = false;
      localSessionClients.set(clientToken, { onFrame, onFatal });
      return createSessionProtocolClient({
        call(name, args = {}, options = {}) {
          if (closed) throw new Error('daemon-local session client is closed');
          return sessionService.handleCall(name, args, {
            clientToken,
            ...(options?.callId ? { callId: String(options.callId) } : {}),
          });
        },
        async close(reason = 'local session view closed') {
          if (closed) return;
          closed = true;
          localSessionClients.delete(clientToken);
          try { sessionService.releaseClient(clientToken); } catch {}
          log(`${reason} (${clientToken})`);
        },
      });
    },
    publish(frame, targetTokens = null) {
      const targets = targetTokens ? new Set(targetTokens) : null;
      for (const [clientToken, client] of localSessionClients) {
        if (targets && !targets.has(clientToken)) continue;
        try { client.onFrame(frame); } catch {}
      }
    },
    async close(reason = 'daemon shutdown') {
      for (const [clientToken, client] of localSessionClients) {
        try { client.onFatal(reason); } catch {}
        try { sessionService.releaseClient(clientToken); } catch {}
      }
      localSessionClients.clear();
    },
  };
  const desktopRuntime = {
    async attachSessionClient(options = {}) {
      if (!localSessionBridge) throw new Error('daemon-local session client is unavailable');
      return localSessionBridge.attach(options);
    },
    loadProjects: () => import('./projects.mjs'),
    loadSessionStore: () => import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    loadStatuslineSegments: () => import('../ui/statusline-segments.mjs'),
    loadConfig: () => import('../runtime/shared/config.mjs'),
    loadCommitCompletion: () => import(
      '../runtime/agent/orchestrator/agent-runtime/commit-message-completion.mjs'
    ),
    async executeCodeGraphTool(name, args, cwd) {
      const graph = await import('../runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
      return graph.executeCodeGraphTool(name, args, cwd);
    },
  };
  let sessionRuntimePrewarmStarted = false;
  let sessionRuntimePrewarmPromise = null;
  sessionRuntimePool = createSessionRuntimePool({ cwd: CWD, log });
  function prewarmSessionRuntime() {
    if (sessionRuntimePrewarmPromise) return sessionRuntimePrewarmPromise;
    sessionRuntimePrewarmStarted = true;
    void import('../runtime/agent/orchestrator/tools/builtin/read-image-resize.mjs')
      .then((module) => module.prewarmImageResizer?.())
      .catch((error) => log(`image pipeline prewarm failed (non-fatal): ${error?.message || error}`));
    sessionRuntimePrewarmPromise = sessionRuntimePool.prewarm()
      .then(() => {
        log('session shard runtime/agent-loop/keychain/provider prewarm ready');
        return true;
      })
      .catch((error) => {
        sessionRuntimePrewarmStarted = false;
        sessionRuntimePrewarmPromise = null;
        log(`session runtime/keychain prewarm failed (non-fatal): ${error?.message || error}`);
        return false;
      });
    return sessionRuntimePrewarmPromise;
  }
  sessionService = createSessionService({
    createSessionRuntime: (options) => sessionRuntimePool.create(options),
    sessionExists: async (sessionId) => {
      const store = await desktopRuntime.loadSessionStore();
      return store.storedSessionExists?.(sessionId) === true;
    },
    // View seam: session.read/subscribe on a cold session serve this disk
    // projection instead of materializing a shard runtime (see
    // session-service.mjs stored-session views).
    readStoredSession: async (sessionId, options = {}) => {
      const store = await desktopRuntime.loadSessionStore();
      if (typeof store.readStoredSessionTranscript !== 'function') return null;
      return await store.readStoredSessionTranscript(sessionId, options) ?? null;
    },
    listSessions: async (options = {}) => {
      const store = await desktopRuntime.loadSessionStore();
      return store.listStoredSessionSummaries({
        refreshFromStorage: options.refreshFromStorage === true,
      });
    },
    getRemoteSessionState: () => remoteSessionState,
    desktopRuntime,
    onFrame: (frame, targetTokens) => {
      localSessionBridge?.publish(frame, targetTokens);
      sessionTransport?.broadcast(frame, targetTokens);
    },
    onExternalClientsChanged: () => { maybeSelfShutdown('remote clients changed'); },
    log,
  });
  sessionTransport = createSessionTransport({
    // ctx carries the CLIENT token: the session pool refcounts views across
    // processes with it, so a terminal exiting cannot destroy the session a
    // desktop window is still streaming.
    handleCall: (name, args, ctx) => sessionService.handleCall(name, args, ctx),
    log,
    // `busy` is what stops a newer install from draining a daemon that is
    // mid-turn: work outlives views AND installs.
    getStatus: () => ({
      sessions: sessionService.size,
      busy: sessionService.busyCount,
      sessionPool: sessionService.status,
      sessionShards: sessionRuntimePool.status,
      // Machine-wide spawn budget + per-shard gate snapshots (cached, lazy
      // refresh): tool execution lives in shard processes, so the daemon's
      // own workload block below only covers daemon-hosted work.
      sessionShardWorkloads: sessionRuntimePool.workloads,
      workload: {
        resources: resourceAdmission.snapshot(),
        childSpawns: childSpawnSnapshot(),
        toolIo: toolWorkloadSnapshot(),
        mcp: getMcpAdmissionSnapshot(),
        providers: providerAdmissionScheduler.snapshot(),
        streamParsing: providerStreamJsonSnapshot(),
      },
      memory: {
        ...(() => {
          const usage = process.memoryUsage();
          return {
            rssBytes: usage.rss,
            heapTotalBytes: usage.heapTotal,
            heapUsedBytes: usage.heapUsed,
            externalBytes: usage.external,
            arrayBufferBytes: usage.arrayBuffers,
          };
        })(),
      },
      ...eventLoopStatus(),
    }),
    onClientsEmpty: () => { maybeSelfShutdown('no live session clients'); },
    onClientRegistered: () => { void prewarmSessionRuntime(); },
    onClientDropped: (token) => { try { sessionService.releaseClient(token); } catch {} },
    onUpgradeRequested: requestDaemonReplacement,
  });
  const sessionEndpoint = await sessionTransport.start();
  writeJsonAtomicSync(DAEMON_DISCOVERY_PATH, {
    protocol: SESSION_PROTOCOL,
    revision: SESSION_REVISION,
    version: runtimeVersion(),
    capabilityFingerprint: SESSION_CAPABILITY_FINGERPRINT,
    pid: process.pid,
    startedAt: Date.now(),
    endpoints: {
      channel: { port, token },
      session: { port: sessionEndpoint.port, token: sessionEndpoint.token },
    },
  }, { compact: true, secret: true });
  log(`session front door on 127.0.0.1:${sessionEndpoint.port}`);

  // Ready handshake for the spawner first. Transport is already listening;
  // signal ready before the heavy
  // channel-worker connect so the spawner's ready wait never blocks on service I/O.
  // Take over file logging from the spawner at the ready boundary. No rotate
  // here: the spawner already bounds the file at its own boot (channel-worker
  // rotateBoundedLog), and rotating now would race other processes' buffered
  // appends into the same log.
  fileLogging = true;
  // Global stderr/console redirect: runtime modules hosted in this daemon
  // (session sweeps, scheduler, inbound handlers, providers…) write raw
  // process.stderr lines. With the current pipe stdio those bytes die with the
  // spawner, and a daemon inherited from an older spawn path prints them into
  // whatever terminal originally launched it — the "[session-sweep] …" text
  // observed inside the TUI composer. Route EVERY stderr/console line to the
  // daemon log so no spawn mode can ever reach a user terminal.
  installDaemonLogRedirect();
  // Guard the ready handshake against a dead/closing parent pipe. process.send
  // delivery is async: if the spawner TUI already exited, the write fails with
  // an async 'error' (EPIPE) that a sync try/catch cannot catch — it would
  // surface as uncaughtException and (pre-fix) flip the daemon degraded
  // forever. process.connected gates the obvious-dead case; the send callback
  // swallows the async delivery error so it never reaches uncaughtException.
  if (process.connected && process.send) {
    safeIpcSend(process, { type: 'ready', port, token });
  }
  log(`ready port=${port} pid=${process.pid} in ${(performance.now() - startedAt).toFixed(0)}ms`);
  eventLoopLagTimer = setInterval(() => {
    const status = eventLoopStatus();
    if (status.eventLoopP99Ms >= 250) {
      log(`event-loop lag p95=${status.eventLoopP95Ms}ms p99=${status.eventLoopP99Ms}ms max=${status.eventLoopMaxMs}ms`);
    }
    eventLoopDelay.reset();
  }, 30_000);
  eventLoopLagTimer.unref?.();

  // Automation may spawn the shared daemon; keep schedules/webhooks live.
  // A TUI-spawned daemon keeps the historical eager start (its channels client
  // is already on the way). A session-spawned one waits for a real channels
  // client — see the transport's onClientRegistered hook.
  if (process.env.MIXDOG_DAEMON_SPAWNED_FOR !== 'session') startChannels();

}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown');
});

main().catch((err) => {
  log(`fatal boot error: ${err?.stack || err?.message || err}`);
  void shutdown('fatal boot error', 2);
});
