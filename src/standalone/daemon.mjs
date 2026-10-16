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
// Before anything can import sharp: Electron on Linux must use its wasm build.
await import('../runtime/shared/sharp-electron-linux.mjs');

// No V8 compile cache here, on purpose. Measured on this runtime: a cache hit
// saves nothing (spawn→ready 316-347ms with the cache vs 318-323ms without,
// lazy compilation is already that cheap), while every miss — first boot
// after an update, every FastDirect deploy — eagerly compiles each module to
// serialize it, turning a 110ms module graph into ~1.2s and taxing the ~900
// lazily imported modules the same way.

import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';
import { listenerLeakWarningLine } from '../runtime/shared/listener-leak-warning.mjs';
import { claimSingletonOwner, readSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import {
  createOwnerHeartbeat,
  daemonOwnerIsStale,
  daemonOwnerTimings,
  discoveryPid,
  proveDaemonOwnerRecord,
  startOwnerLivenessListener,
} from './daemon-owner.mjs';
import { remoteIntentPath } from '../runtime/shared/remote-intent.mjs';
import { modelProxyClientMode } from '../runtime/shared/model-proxy-mode.mjs';
import { setChannelNotifySink } from '../runtime/channels/lib/parent-bridge.mjs';
import { setOwnerContext } from '../runtime/channels/lib/runtime-paths.mjs';
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { releaseAllComputerSessions } from '../runtime/computer-bridge/client.mjs';
import { resourceAdmission } from '../runtime/shared/resource-admission.mjs';
import { createIdleGc } from '../runtime/shared/idle-gc.mjs';
import { snapshot as childSpawnSnapshot } from '../runtime/shared/child-spawn-gate.mjs';
import { toolWorkloadSnapshot } from '../runtime/shared/tool-workload-gates.mjs';
import { providerAdmissionScheduler } from '../runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import {
  closeProviderStreamJsonPool,
  providerStreamJsonSnapshot,
} from '../runtime/agent/orchestrator/providers/stream-json-pool.mjs';
import { createAgentDispatchBroker } from './agent-dispatch-broker.mjs';
import { createChannelTransport } from './channel-transport.mjs';
import { drainDeferral, idleGcEligible } from './daemon-drain-policy.mjs';
import { createDaemonPgStop } from './daemon-pg-stop.mjs';
import { createChannelSessionRouter } from '../session-runtime/services/channel-session-router.mjs';
import { createSessionTransport } from './session-transport.mjs';
import { createSessionService } from './session-service.mjs';
import { createLocalSessionBridge } from './daemon-local-session-bridge.mjs';
import { createStoredSessionViews } from './daemon-stored-session-views.mjs';
import * as quotaResumeStore from '../runtime/shared/quota-resume-store.mjs';
import { registerWorktreeCacheCleanups } from '../runtime/shared/worktrees/cache-cleanups.mjs';
import { createInlineSessionRuntimeHost } from './session-runtime-inline-host.mjs';
import { getStandaloneMemoryRuntime } from '../session-runtime/services/memory-runtime-proxy.mjs';
import { registerTranscriptPurgeHook } from '../session-runtime/session-transcript-purge.mjs';
import { createBootPhaseProfiler } from './boot-phase-profiler.mjs';
import { createDaemonBootCoordinator } from './daemon-boot-coordinator.mjs';
import { createDaemonLog } from './daemon-log.mjs';
import { daemonCrashCaptureDir } from '../session-runtime/services/daemon-crash-capture/paths.mjs';
import {
  installDaemonExitRecorder,
  reconcileLostDaemonCaptures,
} from '../session-runtime/services/daemon-crash-capture/daemon-exit-record.mjs';
import { createDaemonTelemetry, createStallDescriber } from './daemon-telemetry.mjs';
import { slowSpans } from '../runtime/shared/slow-span.mjs';
import { createLagProfiler } from './daemon-lag-profiler.mjs';
import { createChannelsRuntimeLoader } from './daemon-channels-loader.mjs';
import { createDesktopRuntime } from './daemon-desktop-runtime.mjs';
import { createCanonicalAgentControl } from './daemon-agent-control.mjs';
import { flushAllIndexWrites } from '../session-runtime/services/agent-tool/index-write-queue.mjs';
import { registerAutomationAgentTool } from '../session-runtime/automation-agents.mjs';
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
// lines would be lost. So once ready we append through the daemon's file sink,
// keyed to the SAME ready event the spawner detaches on — no loss, no dup.
const LOG_PATH = path.join(DATA_DIR, 'daemon.log');
const {
  log,
  flush: flushDaemonLogs,
  enableFileLogging,
  installRedirect: installDaemonLogRedirect,
} = createDaemonLog({ logPath: LOG_PATH });

// Every way this process ends leaves a reason + exit code in its crash-capture
// sidecar (the launcher usually cannot: it is often gone before the daemon).
const exitRecorder = installDaemonExitRecorder({ dataDir: DATA_DIR });

let channels = null;
let transport = null;
let sessionTransport = null;
let sessionService = null;
let sessionRuntimeHost = null;
let localSessionBridge = null;
let canonicalAgentControl = null;
let memoryRuntime = null;
let transcriptPurgeUnregister = null;
let agentDispatchBroker = null;
let remoteSessionState = { enabled: false, sessionId: null };
let shuttingDown = false;
let shutdownRecheckTimer = null;
let replacementRequested = null;
let ownerHeartbeat = null;
// Answers /health with this pid on the port the owner record names, from
// before the claim until exit (daemon-owner.mjs).
let ownerLiveness = null;
// The endpoints daemon.json carries once published; a heartbeat re-publishes
// them when the file goes missing (TEMP cleanup).
let publishedEndpoints = null;
// Remote mode only: the loopback relay that lets headless runs started from
// model shells (skill scripts) reach the PC behind this daemon's model proxy
// channel (providers/model-proxy-bridge.mjs), and its running-call count.
let modelProxyBridge = null;
let modelProxyBridgeActive = 0;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let idleGc = null;
let daemonTelemetry = null;

function registerMemoryRuntimeLazy() {
  // Register the shared proxy immediately so daemon shutdown owns its
  // lifecycle, but keep the isolated process off the startup path. The first
  // real memory call (memory/recall tools, the Memory install) starts the
  // singleton; nothing warms it at boot. The PG cluster itself usually starts
  // earlier: the channels schedules/webhooks stores open it at boot.
  // Deleting a session removes its transcript file here, and its memory ingest
  // offsets once the memory runtime exists (none when memory is skipped).
  if (!transcriptPurgeUnregister) {
    transcriptPurgeUnregister = registerTranscriptPurgeHook({
      forgetOffsets: (transcriptPaths) => memoryRuntime?.forgetTranscripts(transcriptPaths),
    });
  }
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
    log('memory runtime registered for lazy start');
  } catch (e) {
    log(`memory.start setup failed (non-fatal): ${e?.message || e}`);
  }
}

function memoryUsageBytes() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBufferBytes: usage.arrayBuffers,
  };
}

function eventLoopStatus() {
  const milliseconds = (value) => (Number.isFinite(value) ? Math.round(value / 1e6) : 0);
  return {
    eventLoopP95Ms: milliseconds(eventLoopDelay.percentile(95)),
    eventLoopP99Ms: milliseconds(eventLoopDelay.percentile(99)),
    eventLoopMaxMs: milliseconds(eventLoopDelay.max),
  };
}

/** Ceiling for the whole teardown sequence, above the slowest individual stop
 *  (channels/memory) so a healthy shutdown always finishes on its own. */
const SHUTDOWN_BUDGET_MS = 15_000;
/** Graceful PostgreSQL stop bound inside that budget (pg_ctl stop -m fast). */
const PG_STOP_TIMEOUT_MS = 6_000;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  ownerHeartbeat?.stop();
  exitRecorder.setReason(`shutdown: ${reason}`, code);
  if (shutdownRecheckTimer) {
    clearTimeout(shutdownRecheckTimer);
    shutdownRecheckTimer = null;
  }
  log(`shutting down (${reason})`);
  // Backstop: one wedged stop step must never keep the daemon — and with it the
  // listening port, singleton claim and discovery file — alive. Unref'd so the
  // clean path still exits the moment teardown finishes.
  const forcedExit = setTimeout(() => {
    log('shutdown budget exceeded, forcing exit');
    exitRecorder.setReason(`shutdown: ${reason} (budget exceeded, forced exit)`, code);
    process.exit(code);
  }, SHUTDOWN_BUDGET_MS);
  forcedExit.unref?.();
  // PostgreSQL stops after its users below (durable writes drained first), or
  // at the fallback point just before the launcher's kill, whichever is first.
  const pgStop = createDaemonPgStop({ log, stopTimeoutMs: PG_STOP_TIMEOUT_MS });
  try {
    setChannelNotifySink(null);
  } catch {}
  // Abort every relayed model call, close the bridge sockets and wait for the
  // calls to settle before anything they depend on goes away.
  try {
    await modelProxyBridge?.close(`daemon shutdown: ${reason}`);
  } catch (e) {
    log(`model proxy bridge stop failed: ${e?.message || e}`);
  }
  try {
    await sessionService?.stop?.(reason);
  } catch (e) {
    log(`session service stop failed: ${e?.message || e}`);
  }
  try {
    await sessionRuntimeHost?.close?.(reason);
  } catch (e) {
    log(`session runtime host stop failed: ${e?.message || e}`);
  }
  // Every runtime is closed: drain the canonical agent's index writers (and any
  // other queued index write) before process.exit, whose 'exit' hook cannot
  // finish async work.
  try {
    await canonicalAgentControl?.dispose?.();
    await flushAllIndexWrites();
  } catch (e) {
    log(`agent index drain failed: ${e?.message || e}`);
  }
  // Host-side Computer Use workers and target claims are reaped only on an
  // explicit release; the runtime's deferred timer is unref'd and never fires
  // once this process exits.
  try {
    await releaseAllComputerSessions();
  } catch (e) {
    log(`computer session release failed: ${e?.message || e}`);
  }
  try {
    await localSessionBridge?.close?.(reason);
  } catch (e) {
    log(`local session bridge.close failed: ${e?.message || e}`);
  }
  try {
    await sessionTransport?.stop?.();
  } catch (e) {
    log(`session transport stop failed: ${e?.message || e}`);
  }
  try {
    await channels?.stop?.();
  } catch (e) {
    log(`channels.stop failed: ${e?.message || e}`);
  }
  // The daemon only releases its client registration. The isolated memory
  // process shuts down after its last live client disappears.
  try {
    await memoryRuntime?.stop?.();
  } catch (e) {
    log(`memory.stop failed: ${e?.message || e}`);
  }
  // PostgreSQL this daemon started through its stores (schedules, webhooks,
  // session search) after every user of it above is closed. `pg_ctl start`
  // daemonizes the postmaster outside this process tree, so without this stop
  // it outlives the daemon. A cluster another live process owns is left to it.
  await pgStop.finish();
  try {
    agentDispatchBroker?.close?.(reason);
  } catch (e) {
    log(`agent broker stop failed: ${e?.message || e}`);
  }
  try {
    await closeProviderStreamJsonPool(reason);
  } catch (e) {
    log(`stream parser stop failed: ${e?.message || e}`);
  }
  try {
    await transport?.stop?.();
  } catch (e) {
    log(`transport.stop failed: ${e?.message || e}`);
  }
  idleGc?.disarm();
  daemonTelemetry?.stop();
  eventLoopDelay.disable();
  try {
    // Only our own: a successor that reclaimed a stale owner record may
    // already have published its endpoint here.
    if (discoveryPid(DAEMON_DISCOVERY_PATH) === process.pid) rmSync(DAEMON_DISCOVERY_PATH, { force: true });
  } catch {}
  try {
    releaseSingletonOwner(OWNER_PATH, process.pid);
  } catch {}
  await flushDaemonLogs();
  process.exit(code);
}

/** Work actually running right now, across both front doors. Self-shutdown
 *  asks whether this process may exit; idle GC asks whether a pause is safe. */
function inFlightWork() {
  return {
    activeCalls: (transport?.activeCount ?? 0) + (sessionTransport?.activeCount ?? 0) + modelProxyBridgeActive,
    queuedCalls: (transport?.queuedCount ?? 0) + (sessionTransport?.queuedCount ?? 0),
    busySessions: sessionService?.busyCount ?? 0,
    busyMemoryAgents: agentDispatchBroker?.snapshot?.().inFlight ?? 0,
    turnBusySessions: sessionService?.turnBusyCount ?? 0,
  };
}

// Opt-in CPU profiling of lag windows while DATA_DIR/lag-profile.on exists.
const lagProfiler = createLagProfiler({ dataDir: DATA_DIR, log });
// Request spans share the heartbeat's performance.now() clock; `[slow-op]` lines
// and stall attribution come from the same recorder.
slowSpans.setLog(log);

daemonTelemetry = createDaemonTelemetry({
  log,
  getWork: inFlightWork,
  onInterval() {
    // eventLoopDelay is reset at the end of every tick, so this status is the
    // lag of the 30s window that just ended — the same window the lag
    // profiler stops and judges below.
    const status = eventLoopStatus();
    void lagProfiler.tick({
      p99Ms: status.eventLoopP99Ms,
      maxMs: status.eventLoopMaxMs,
      busySessions: inFlightWork().busySessions,
    });
    if (status.eventLoopP99Ms >= 250) {
      log(
        `event-loop lag p95=${status.eventLoopP95Ms}ms p99=${status.eventLoopP99Ms}ms max=${status.eventLoopMaxMs}ms`
      );
    }
    // Legacy external runtime hosts may still report shard-local lag. The
    // production in-process host is already covered by daemon loop telemetry.
    const shards = sessionRuntimeHost?.status?.shards || [];
    const lagging = shards.filter((shard) => Number(shard?.lag?.p99Ms) >= 250 || shard?.degraded);
    if (lagging.length > 0) {
      log(
        `session runtime shard lag ${lagging
          .map(
            (shard) =>
              `#${shard.index}${shard.degraded ? '(quarantined)' : ''}` +
              ` p95=${shard.lag?.p95Ms ?? -1}ms p99=${shard.lag?.p99Ms ?? -1}ms` +
              ` max=${shard.lag?.maxMs ?? -1}ms runtimes=${shard.runtimes}`
          )
          .join(' ')}`
      );
    }
    eventLoopDelay.reset();
  },
});

/** One process, two front doors (channels + sessions): an idle side must never
 *  evict a busy one, so every self-shutdown trigger checks BOTH registries. */
let _lastDeferredLog = { key: '', at: 0, suppressed: 0 };
function maybeSelfShutdown(reason) {
  const channelClients = transport?.clientCount ?? 0;
  const sessionClients = sessionTransport?.clientCount ?? 0;
  const remoteClients = sessionService?.externalClientCount ?? 0;
  const replacing = Boolean(replacementRequested);
  if (!replacing && (channelClients > 0 || sessionClients > 0 || remoteClients > 0)) {
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
      const suffix =
        _lastDeferredLog.suppressed > 0 ? ` (+${_lastDeferredLog.suppressed} identical defers suppressed)` : '';
      log(
        `shutdown deferred (${reason}): channels=${channelClients} sessionClients=${sessionClients} remote=${remoteClients}${suffix}`
      );
      _lastDeferredLog = { key: deferKey, at: now, suppressed: 0 };
    }
    return;
  }
  const { activeCalls, queuedCalls, busySessions, busyMemoryAgents } = inFlightWork();
  const deferral = drainDeferral(
    { activeCalls, queuedCalls, busySessions, busyMemoryAgents },
    { force: replacementRequested?.force === true }
  );
  if (deferral === 'calls') {
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
  if (deferral === 'busy') {
    log(`shutdown deferred (${reason}): busySessions=${busySessions}` + ` memoryAgents=${busyMemoryAgents}`);
    if (!shutdownRecheckTimer) {
      shutdownRecheckTimer = setTimeout(() => {
        shutdownRecheckTimer = null;
        maybeSelfShutdown('busy service work settled');
      }, 1_000);
      shutdownRecheckTimer.unref?.();
    }
    return;
  }
  if (replacing) {
    sessionTransport?.commitDrain?.(reason);
    transport?.commitDrain?.(reason);
  }
  void shutdown(reason);
}

function requestDaemonReplacement({ protocol, revision, version, force } = {}) {
  const forced = force === true;
  const requested = {
    force: forced,
    protocol: Number(protocol),
    revision: Math.max(0, Number(revision) || 0),
    version: String(version || '0.0.0'),
  };
  if (requested.protocol !== SESSION_PROTOCOL) return false;
  const revisionOrder = requested.revision - SESSION_REVISION;
  const versionOrder = compareRuntimeVersions(requested.version, runtimeVersion());
  if (revisionOrder < 0 || (revisionOrder === 0 && versionOrder <= 0)) return false;
  if (
    replacementRequested &&
    requested.revision === replacementRequested.revision &&
    requested.version === replacementRequested.version &&
    !(forced && replacementRequested.force !== true)
  )
    return true;
  replacementRequested = requested;
  const reason = `daemon replacement by revision/build ${requested.revision}/${requested.version}`;
  if (forced) log(`${reason} FORCED — aborting in-flight work (sessions, service calls, agent runs)`);
  else log(`${reason} requested — preserving clients until live work settles`);
  sessionTransport?.beginDrain?.(reason);
  transport?.beginDrain?.(reason);
  maybeSelfShutdown(reason);
  return true;
}

/** Pid-verified singleton claim (claimSingletonOwner reclaims a dead-pid owner
 *  file and refuses only a LIVE peer). Loser exits so the spawner attaches to
 *  the winner instead of running a second daemon. */
async function claimDaemonOwnership(bootPhases) {
  const timings = daemonOwnerTimings();
  // A live-pid record is reclaimable only when its holder's endpoint does not
  // answer with its pid (daemon-owner.mjs); probed before the sync claim.
  const proof = await proveDaemonOwnerRecord(OWNER_PATH, {
    discoveryPath: DAEMON_DISCOVERY_PATH,
    staleMs: timings.staleMs,
  });
  // Up BEFORE the claim, so even the first record names a port that answers
  // with this pid: a contender never reclaims a booting daemon on a stale-
  // looking stamp (a clock jump) alone.
  ownerLiveness = await startOwnerLivenessListener({ log });
  const claim = claimSingletonOwner(OWNER_PATH, {
    kind: 'mixdog-daemon',
    pid: process.pid,
    meta: {
      cwd: CWD,
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: runtimeVersion(),
      heartbeatAt: new Date().toISOString(),
      ...(ownerLiveness ? { livenessPort: ownerLiveness.port } : {}),
    },
    // A live pid that neither beats nor answers is a reused pid, not a peer.
    isStale: (owner) => {
      const stale = daemonOwnerIsStale(owner, { proof, staleMs: timings.staleMs });
      if (stale) {
        log(
          `reclaiming stale owner record pid=${owner.pid} claimedAt=${owner.claimedAt}` +
            ` heartbeatAt=${owner.heartbeatAt ?? '-'} probe=${proof?.verdict ?? '-'}`
        );
      }
      return stale;
    },
  });
  if (!claim.owned) {
    log(`live peer holds owner lock (pid=${claim.owner?.pid}) — exiting for attach`);
    void ownerLiveness?.close();
    ownerLiveness = null;
    exitRecorder.setReason(`lost singleton claim to live peer pid=${claim.owner?.pid}`, 0);
    process.exit(0);
  }
  bootPhases.mark('owner-claimed');
  // Beats from here on, through boot: a slow boot is never mistaken for a
  // reused pid. Losing the record to another pid, or the lease running out
  // unrefreshed, means another daemon owns (or may now claim) this data dir —
  // at most one may keep serving.
  ownerHeartbeat = createOwnerHeartbeat({
    ownerPath: OWNER_PATH,
    owner: claim.owner,
    heartbeatMs: timings.heartbeatMs,
    fenceMs: timings.fenceMs,
    tickMs: timings.tickMs,
    stallMs: timings.stallMs,
    log,
    describeStall: createStallDescriber({ spans: slowSpans, getWork: inFlightWork }),
    onBeat: republishMissingDiscovery,
    onSuperseded: (record) => fenceDaemon(`owner claim superseded by pid=${record?.pid}`),
    onFenced: ({ lastRefreshAt, sinceMs }) =>
      fenceDaemon(`owner lease expired (no refresh for ${sinceMs}ms, last ${lastRefreshAt})`),
  });
  ownerHeartbeat.start();
  process.on('exit', () => {
    try {
      releaseSingletonOwner(OWNER_PATH, process.pid);
    } catch {}
  });
}

/** One line per finished turn: the daemon-side split of its latency is recorded
 *  nowhere else, and the emitting runtime lives in this process. */
function installTurnTimingLog() {
  process.on('mixdog:turn-timing', (row = {}) => {
    const ms = (value) => (Number.isFinite(value) ? Math.round(value) : -1);
    log(
      `turn timing status=${row.status || 'unknown'} session=${row.sessionId || '-'}` +
        ` e2e=${ms(row.endToEndTtftMs)}ms runtime=${ms(row.ttftMs)}ms` +
        ` queue=${ms(row.queueMs)}ms route=${ms(row.routeMs)}ms` +
        ` preflight=${ms(row.preflightMs)}ms mcp=${ms(row.mcpMs)}ms` +
        ` provider=${ms(row.providerMs)}ms`
    );
  });
}

/** Listener-leak warnings reach daemon.log with the stack that names their
 *  source (observed: 51 abort listeners on one AbortSignal in an 11h daemon,
 *  source unknown). */
function installListenerLeakLog() {
  process.on('warning', (warning) => {
    const line = listenerLeakWarningLine(warning);
    if (line) log(line);
  });
}

/** What the session front door reports about this process: session counts plus
 *  every admission/workload gate the daemon owns.
 *  `busy` is what stops a newer install from draining a daemon that is
 *  mid-turn: work outlives views AND installs. */
function daemonStatusSnapshot() {
  return {
    sessions: sessionService.size,
    busy: sessionService.busyCount,
    sessionService: sessionService.status,
    sessionRuntime: sessionRuntimeHost.status,
    sessionRuntimeWorkload: sessionRuntimeHost.workloads,
    workload: {
      resources: resourceAdmission.snapshot(),
      childSpawns: childSpawnSnapshot(),
      toolIo: toolWorkloadSnapshot(),
      // MCP runs in session/agent workers, never in this daemon process.
      mcp: {},
      providers: providerAdmissionScheduler.snapshot(),
      streamParsing: providerStreamJsonSnapshot(),
    },
    memory: memoryUsageBytes(),
    ...eventLoopStatus(),
  };
}

/** The file every attacher reads to find this daemon: wire identity plus both
 *  loopback endpoints and their privileged tokens. */
function publishDaemonDiscovery({ channel, session, modelProxy = null }) {
  // A re-publish keeps the first publication's startedAt.
  publishedEndpoints = { channel, session, modelProxy, startedAt: publishedEndpoints?.startedAt ?? Date.now() };
  writeJsonAtomicSync(
    DAEMON_DISCOVERY_PATH,
    {
      protocol: SESSION_PROTOCOL,
      revision: SESSION_REVISION,
      version: runtimeVersion(),
      capabilityFingerprint: SESSION_CAPABILITY_FINGERPRINT,
      pid: process.pid,
      startedAt: publishedEndpoints.startedAt,
      endpoints: {
        channel: { port: channel.port, token: channel.token },
        session: { port: session.port, token: session.token },
        ...(modelProxy ? { modelProxy: { port: modelProxy.port, token: modelProxy.token } } : {}),
      },
    },
    { compact: true, secret: true }
  );
}

/** Remote mode only: the model proxy bridge endpoint to publish, or null. */
async function startModelProxyBridge(bootPhases) {
  if (!modelProxyClientMode()) return null;
  const [{ createModelProxyBridgeServer }, { getModelProxyChannel }] = await Promise.all([
    import('../runtime/agent/orchestrator/providers/model-proxy-bridge.mjs'),
    import('../runtime/agent/orchestrator/providers/model-proxy-channel.mjs'),
  ]);
  modelProxyBridge = createModelProxyBridgeServer({
    channel: getModelProxyChannel(),
    // Fenced or shutting down: no new relayed call.
    admit: () => !shuttingDown && admitOwnerWork(),
    trackWork: (active) => {
      modelProxyBridgeActive = active;
    },
    log,
  });
  const endpoint = await bootPhases.measure('model-proxy-bridge-start', () => modelProxyBridge.start());
  log(`model proxy bridge on 127.0.0.1:${endpoint.port}`);
  return endpoint;
}

/** Asked by both front doors before every register/call: an expired lease
 *  fences here (answered 503), and after an event-loop stall nothing is
 *  served until the record is re-verified as ours. */
function admitOwnerWork() {
  return ownerHeartbeat ? ownerHeartbeat.admit() : true;
}

/** This process no longer holds (or is about to lose) the owner lease: refuse
 *  new work at once, unpublish its endpoint so launchers stop finding it, then
 *  shut down within the shutdown budget — before a contender may reclaim. */
function fenceDaemon(reason) {
  if (shuttingDown) return;
  log(`${reason} — refusing new work and stopping so only one daemon serves`);
  sessionTransport?.commitDrain?.(reason);
  transport?.commitDrain?.(reason);
  modelProxyBridge?.abortAll(reason);
  try {
    if (discoveryPid(DAEMON_DISCOVERY_PATH) === process.pid) rmSync(DAEMON_DISCOVERY_PATH, { force: true });
  } catch (e) {
    log(`daemon.json unpublish failed: ${e?.message || e}`);
  }
  void shutdown(reason);
}

/** Heartbeat follow-up while this process still owns the lock: a daemon.json
 *  deleted (TEMP cleanup) or overwritten while it runs is written again, so
 *  new clients keep finding the one daemon that serves this data dir. */
function republishMissingDiscovery() {
  if (!publishedEndpoints || shuttingDown || discoveryPid(DAEMON_DISCOVERY_PATH) === process.pid) return;
  try {
    publishDaemonDiscovery(publishedEndpoints);
    log('daemon.json was missing or named another pid — re-published');
  } catch (error) {
    log(`daemon.json re-publish failed: ${error?.message || error}`);
  }
}

/** Ready handshake for the spawner, plus the log-sink handoff pinned to the
 *  same boundary. Transport is already listening; signal ready before the heavy
 *  channel-worker connect so the spawner's ready wait never blocks on service
 *  I/O. */
function announceDaemonReady({ port, token, startedAt, bootPhases }) {
  // Take over file logging from the spawner at the ready boundary. No rotate
  // here: the spawner already bounds the file at its own boot (channel-worker
  // rotateBoundedLog), and rotating now would race other processes' buffered
  // appends into the same log.
  enableFileLogging();
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
  bootPhases.mark('daemon-ready');
  // One unref'd 30s loop: memory/work samples plus event-loop lag. A crash
  // still has a recent RSS/heap/limit record in daemon.log; the 10-minute
  // memory-pressure file is too sparse to be that record.
  daemonTelemetry.emit('boot');
  daemonTelemetry.start();
  // Off the ready path: settle earlier boots that ended with no recorded exit
  // (killed together with their launcher's process tree).
  setImmediate(() => {
    try {
      const marked = reconcileLostDaemonCaptures({ dir: daemonCrashCaptureDir({ dataDir: DATA_DIR }) });
      if (marked > 0)
        log(`previous daemon boot(s) ended without an exit record: ${marked} marked unrecorded-termination`);
    } catch {}
  });
}

/** After ready, off every request path: arm the last-chance PostgreSQL stop on
 *  exit, then open the schedules/webhooks stores. On an existing cluster that
 *  starts PostgreSQL here, so the first catalog read (the desktop sidebar's
 *  channel setup) joins this start instead of being the one that runs it; a
 *  data dir with no cluster yet starts nothing (channel-admin). Loaded after
 *  the stderr redirect, so the PG layer's logs reach daemon.log. */
function startPostgresInBackground() {
  void import('../runtime/memory/lib/pg/adapter.mjs')
    .then((pg) => {
      pg.installOwnedPgExitStop();
      if (shuttingDown) return null;
      return import('../session-runtime/services/channel-admin.mjs').then((admin) => admin.hasActiveAutomation());
    })
    .catch((error) => log(`postgres background start failed: ${error?.message || error}`));
}

/** The channels front door: pointer-routed calls over HTTP+SSE. Creating the
 *  transport also wires the channels notification sink (session-bound
 *  notifications reach the session service, the rest fan out to channel
 *  clients); starting it yields this daemon's channel endpoint. */
async function startChannelFrontDoor({ channelsRuntime, bootPhases }) {
  transport = createChannelTransport({
    handleCall: channelsRuntime.handleCall,
    agentBroker: agentDispatchBroker,
    admitWork: admitOwnerWork,
    log,
    // The durable channel link lives in this file. Without it a restart loses
    // the pinned session (nothing to restore) and every catalog reports Remote
    // disabled because no state ever reaches getRemoteSessionState().
    remoteIntentPath: remoteIntentPath(RUNTIME_ROOT),
    onRemoteStateChange: (state) => {
      remoteSessionState = {
        enabled: state?.enabled === true,
        sessionId: state?.sessionId ?? null,
        cwd: state?.cwd ?? null,
        daemonPid: state?.daemonPid ?? process.pid,
        updatedAt: state?.updatedAt ?? Date.now(),
      };
    },
    // Self-shutdown when the last attached TUI leaves (reuses the SSE/client
    // registry as the liveness signal).
    onClientsEmpty: () => {
      maybeSelfShutdown('no live channel clients');
    },
    // First channels client in: bring the channels runtime up (see the loader).
    onClientRegistered: () => {
      channelsRuntime.start();
    },
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
  return bootPhases.measure('channel-transport-start', () => transport.start());
}

async function main() {
  const startedAt = performance.now();
  const bootPhases = createBootPhaseProfiler({ log, startedAt });
  // processMs = fork → here (runtime start + module graph). The spawner sees
  // only spawn → ready, so this is what separates a slow launch from a slow
  // boot when the desktop attributes its daemon wait.
  bootPhases.mark('daemon-main', { processMs: Math.round(process.uptime() * 1000) });
  // The discovery file carries both privileged loopback tokens. POSIX roots
  // are per-user and fail closed if another account owns the configured path.
  ensurePrivateRuntimeRoot(RUNTIME_ROOT);

  await claimDaemonOwnership(bootPhases);
  registerMemoryRuntimeLazy();
  // Every in-process session runtime removes managed worktrees through the
  // shared manager; its root cleanups drop the path-keyed caches (turn
  // snapshots, code graph) of a removed worktree. Modules load on first use.
  registerWorktreeCacheCleanups();
  // Managed worktrees, off the boot path: finish interrupted deletions and
  // creations, release stale leases and, with autoCleanup on, remove clean,
  // merged worktrees no stored session retains (never one a session keeps).
  void import('../runtime/shared/worktrees/maintenance.mjs')
    .then((maintenance) => maintenance.reconcileWorktreesAtStartup())
    .then((report) => {
      const changed = report.removed.length + report.recovered.length + report.pruned.length;
      if (changed || report.errors.length) {
        log(
          `worktree reconcile: removed ${report.removed.length}, recovered ${report.recovered.length}, ` +
            `pruned ${report.pruned.length}, errors ${report.errors.length}`
        );
      }
    })
    .catch((error) => log(`worktree reconcile failed: ${error?.message || error}`));
  // The daemon owns prompt attachments; its census runs off the boot path
  // (first attempt after the store's start delay, then per its interval).
  void import('../runtime/attachments/store.mjs').then((store) => store.startAttachmentGc()).catch(() => {});
  // Session-search backfill: once per run, well after boot, low priority.
  const sessionSearchBackfillTimer = setTimeout(() => {
    void import('../runtime/session-search/session-search-ingest.mjs')
      .then((search) => search.backfillSessionSearch())
      .catch((error) => log(`session-search backfill failed: ${error?.message || error}`));
  }, 60_000);
  sessionSearchBackfillTimer.unref?.();
  // The first session per repository would otherwise run `git status` and
  // `git check-ignore` synchronously while composing its prompt. Registered
  // projects (a small JSON list, most recently selected first) are the cwds
  // sessions open; prewarm their probes on the git worker, off the boot path.
  void Promise.all([
    import('../runtime/shared/projects.mjs'),
    import('../runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs'),
  ])
    .then(([projects, capabilities]) =>
      capabilities.prewarmGitStartupProbes(
        projects
          .listProjects()
          .slice(0, 8)
          .map((project) => project.path)
      )
    )
    .catch(() => {});
  agentDispatchBroker = createAgentDispatchBroker({
    // Memory-cycle agents use the same lazy provider/orchestrator graph as
    // session actors; it stays unloaded until a real cycle requests it.
    dispatchAgent: (payload, options) => {
      if (!sessionRuntimeHost) throw new Error('session runtime host is not ready');
      return sessionRuntimeHost.agentDispatch(payload, options);
    },
    log,
    onActivityChanged: () => {
      maybeSelfShutdown('memory agent activity changed');
    },
  });
  installTurnTimingLog();
  installListenerLeakLog();

  // Reclaim deferred garbage while nothing is in flight. V8 keeps a long-lived
  // daemon's dead transcripts resident for as long as the heap limit stays out
  // of sight; a measured sweep on this daemon returned 140MB in 98ms.
  idleGc = createIdleGc({ isBusy: () => !idleGcEligible(inFlightWork()), log });
  if (idleGc.arm()) log('idle gc armed');

  const channelsRuntime = createChannelsRuntimeLoader({
    log,
    // shutdown() tears the channels runtime down in a fixed order, so the
    // module handle stays on this process rather than inside the loader.
    onLoaded: (module) => {
      channels = module;
    },
    setOwnerContext,
  });
  const { port, token } = await startChannelFrontDoor({ channelsRuntime, bootPhases });
  // Memory-cycle agent dispatch is rare and initializes on first use. Eagerly
  // loading its provider graph here consumed the control loop before any
  // memory cycle requested it.

  localSessionBridge = createLocalSessionBridge({ getSessionService: () => sessionService, log });
  const desktopRuntime = createDesktopRuntime({ getLocalSessionBridge: () => localSessionBridge });
  const storedSessionViews = createStoredSessionViews({ desktopRuntime, dataDir: DATA_DIR });
  const agentControl = createCanonicalAgentControl({
    getSessionService: () => sessionService,
    getSessionRuntimeHost: () => sessionRuntimeHost,
    cwd: CWD,
  });
  canonicalAgentControl = agentControl;
  // Schedules and webhooks run headless here; their sessions reach the same
  // canonical agent control through the automation tool scope.
  registerAutomationAgentTool(agentControl.execute);
  const requestedRuntimeMode = String(process.env.MIXDOG_SESSION_RUNTIME_MODE || '')
    .trim()
    .toLowerCase();
  if (requestedRuntimeMode && requestedRuntimeMode !== 'inline') {
    log(
      `MIXDOG_SESSION_RUNTIME_MODE=${requestedRuntimeMode} is no longer supported; using the inline session runtime host`
    );
  }
  sessionRuntimeHost = createInlineSessionRuntimeHost({
    cwd: CWD,
    log,
    measureBootPhase: bootPhases.measure,
    executeAgentControl: agentControl.execute,
  });
  // Codex-style runtime: daemon routing and independent async session actors
  // share one V8 isolate and module graph. CPU-heavy work stays in bounded
  // native helpers/worker pools instead of duplicating the whole runtime.
  log(`session runtime mode=${sessionRuntimeHost.status.mode}`);
  const bootCoordinator = createDaemonBootCoordinator({
    prewarmKeychain: () => sessionRuntimeHost.prewarmKeychain(),
    recoverActiveGoals: () => sessionService.recoverActiveGoals(),
    startQuotaResume: () => sessionService.startQuotaResume(),
    // The modules every rail catalog request needs (session summaries,
    // projects, statusline segments) — warm them once the desktop is up so
    // the first Sessions/Projects click reads a hot module graph.
    prewarmCatalogs: () =>
      Promise.all([
        desktopRuntime.loadSessionStore(),
        desktopRuntime.loadProjects(),
        desktopRuntime.loadStatuslineSegments(),
        import('../runtime/agent/orchestrator/session/store.mjs'),
      ]),
    measure: (phase, task) => bootPhases.measure(phase, task),
    log,
  });
  sessionService = createSessionService({
    createSessionRuntime: (options) => sessionRuntimeHost.create(options),
    ...storedSessionViews,
    getRemoteSessionState: () => remoteSessionState,
    desktopRuntime,
    onFrame: (frame, targetTokens) => {
      localSessionBridge?.publish(frame, targetTokens);
      sessionTransport?.broadcast(frame, targetTokens);
    },
    onExternalClientsChanged: () => {
      maybeSelfShutdown('remote clients changed');
    },
    onDesktopReady: () => bootCoordinator.notifyDesktopReady(),
    quotaResumeStore,
    readQuotaUsable: async (provider, model) => {
      const { providerQuotaUsable } = await import('../runtime/agent/orchestrator/providers/quota-reading.mjs');
      return providerQuotaUsable(provider, model);
    },
    log,
  });
  sessionTransport = createSessionTransport({
    // ctx carries the CLIENT token: the session service refcounts views across
    // processes with it, so a terminal exiting cannot destroy the session a
    // desktop window is still streaming.
    handleCall: (name, args, ctx) => sessionService.handleCall(name, args, ctx),
    log,
    getStatus: daemonStatusSnapshot,
    onClientsEmpty: () => {
      maybeSelfShutdown('no live session clients');
    },
    onClientRegistered: (client) => bootCoordinator.notifyClientRegistered(client),
    onClientDropped: (token) => {
      try {
        sessionService.releaseClient(token);
      } catch {}
    },
    onUpgradeRequested: requestDaemonReplacement,
    admitWork: admitOwnerWork,
  });
  const sessionEndpoint = await bootPhases.measure('session-transport-start', () => sessionTransport.start());
  const modelProxyEndpoint = await startModelProxyBridge(bootPhases);
  // A boot whose holder stopped answering may have been superseded by a
  // contender between beats; never publish over the winner's endpoint. An
  // unreadable record (an antivirus lock) is not a takeover.
  const ownerPid = Number(readSingletonOwner(OWNER_PATH).owner?.pid) || 0;
  if (shuttingDown) return;
  if (ownerPid && ownerPid !== process.pid) {
    log(`owner record now names pid=${ownerPid} — exiting for attach before publishing`);
    exitRecorder.setReason(`owner claim superseded by pid=${ownerPid} before publish`, 0);
    process.exit(0);
  }
  publishDaemonDiscovery({ channel: { port, token }, session: sessionEndpoint, modelProxy: modelProxyEndpoint });
  bootPhases.mark('discovery-published');
  log(`session front door on 127.0.0.1:${sessionEndpoint.port}`);

  announceDaemonReady({ port, token, startedAt, bootPhases });
  // After ready, off the boot path: load the session-runtime module tree so
  // the first session.create does not block the loop on synchronous module
  // compilation. Failures fall back to the lazy import inside create.
  setImmediate(() => {
    void sessionRuntimeHost?.warmLocalRuntime?.();
  });
  startPostgresInBackground();

  // Automation may spawn the shared daemon; keep schedules/webhooks live.
  // A TUI-spawned daemon keeps the historical eager start (its channels client
  // is already on the way). A session-spawned one waits for a real channels
  // client — see the transport's onClientRegistered hook.
  if (process.env.MIXDOG_DAEMON_SPAWNED_FOR !== 'session') channelsRuntime.start();

  // A pinned channel session outlives the daemon that pinned it. Reactivate the
  // durable intent AFTER the ready handshake (activation itself brings the
  // messaging bridge up); with no intent on disk this is a no-op and the
  // channels graph stays dormant.
  if (transport.remoteIntentSessionId) {
    void transport
      .restoreRemoteIntent()
      .then((restored) => {
        if (!restored) log('remote intent restore declined (session unavailable)');
      })
      .catch((error) => log(`remote intent restore failed: ${error?.message || error}`));
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
// Console close / Ctrl+Break: the default action ends the process with no hook.
process.on('SIGHUP', () => {
  void shutdown('SIGHUP');
});
process.on('SIGBREAK', () => {
  void shutdown('SIGBREAK');
});
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown');
});

main().catch((err) => {
  log(`fatal boot error: ${err?.stack || err?.message || err}`);
  void shutdown('fatal boot error', 2);
});
