import { execFile, fork, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startChildGuardian } from '../runtime/shared/child-guardian.mjs';
import { detachedSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import { appendBuffered } from '../runtime/shared/buffered-appender.mjs';
import { scrubLoaderVars } from '../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';
import { attachToDaemon, readDaemonDiscovery, probeDaemonHealth } from './channel-daemon-client.mjs';
import { claimSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { randomUUID } from 'node:crypto';

const CHANNEL_TOOLS = new Set([
  'reply',
  'fetch',
  // activate_channel_bridge/reload_config are NOT model-facing tools (no
  // TOOL_DEFS entry) but stay in the allow-set: mixdog-session-runtime.mjs
  // calls channels.execute() with these names directly as internal
  // Lead-only runtime plumbing (bridge-claim on start, config hot-reload).
  'activate_channel_bridge',
  'reload_config',
  // Lead-pushed transcript repoint (auto-acquire / newSession / resume /
  // clear). Not model-facing; internal Lead-only runtime plumbing.
  'rebind_current_transcript',
]);

const WORKER_PRELOAD = fileURLToPath(new URL('./channel-worker-preload.cjs', import.meta.url));
// Machine-global channels daemon entry (spawn-or-attach target). Overridable
// via env so smokes can point at a stub daemon (no Discord token). Resolved
// LAZILY at spawn time — an import-time constant would freeze before a smoke
// that imports this module first gets a chance to set the env override.
function daemonEntry() {
  return process.env.MIXDOG_CHANNEL_DAEMON_ENTRY
    ? resolve(process.env.MIXDOG_CHANNEL_DAEMON_ENTRY)
    : fileURLToPath(new URL('./channel-daemon.mjs', import.meta.url));
}

// A global package update can briefly remove channel-worker-preload.cjs while
// the worker is spawning (MODULE_NOT_FOUND boot crash). Retry once before
// surfacing the failure to callers.
const WORKER_BOOT_MAX_ATTEMPTS = 2;
const WORKER_BOOT_RETRY_DELAY_MS = 1000;
// Fail an in-flight IPC send whose flush callback never fires (wedged channel)
// so the FIFO send queue can't stall permanently on one stuck message.
const SEND_FLUSH_TIMEOUT_MS = 10_000;

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendBuffered(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never break the TUI.
  }
}

const CHANNEL_WORKER_EXIT_CLEANUPS = new Set();
let channelWorkerExitHookInstalled = false;

function registerChannelWorkerExitCleanup(cleanup) {
  if (typeof cleanup !== 'function') return () => {};
  CHANNEL_WORKER_EXIT_CLEANUPS.add(cleanup);
  if (!channelWorkerExitHookInstalled) {
    channelWorkerExitHookInstalled = true;
    process.once('exit', () => {
      for (const fn of Array.from(CHANNEL_WORKER_EXIT_CLEANUPS)) {
        try { fn(); } catch {}
      }
      CHANNEL_WORKER_EXIT_CLEANUPS.clear();
    });
  }
  return () => {
    CHANNEL_WORKER_EXIT_CLEANUPS.delete(cleanup);
  };
}

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT ? resolve(process.env.MIXDOG_RUNTIME_ROOT) : join(tmpdir(), 'mixdog');
}

export function createStandaloneChannelWorker({
  entry,
  rootDir,
  dataDir,
  cwd = process.cwd(),
  onNotify,
} = {}) {
  if (!entry) throw new Error('channels runtime entry is required');
  if (!rootDir) throw new Error('channels runtime rootDir is required');
  if (!dataDir) throw new Error('channels runtime dataDir is required');

  let child = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let stopPromise = null;
  let stopRequested = false;
  let bootGeneration = 0;
  let inProcessMod = null;
  let inProcessStartPromise = null;
  // Set when in-process mode (MIXDOG_CHANNEL_WORKER_PROCESS=0) holds the daemon
  // singleton lock, so stop() releases it (never double-own beside a daemon).
  let inProcessOwned = false;
  // Machine-global channels daemon attach handle. Replaces the per-TUI fork +
  // node-IPC call/notify plumbing; the daemon is SHARED and never killed on
  // this TUI's exit (only detached-from). The fork machinery below is retained
  // as an unreachable legacy path while useProcessWorker is true.
  let daemonClient = null;
  let attachPromise = null;
  let attachGeneration = 0;
  let daemonPid = null;
  let nextCallId = 1;
  // Per-proxy unique prefix so a callId can never collide across TUIs sharing
  // the same supervisor pid (which would cross-dedup two distinct calls).
  const proxyId = randomUUID();
  let parentExitCleanup = null;
  const pending = new Map();
  const ownedChildPids = new Set();
  // Strict-FIFO backpressure queue for child IPC. child.send returns false
  // when the channel is over its backpressure threshold; we keep at most one
  // send in flight and only dispatch the next once the prior send's flush
  // callback fires, so bursts don't unboundedly buffer and order is preserved.
  const sendQueue = [];
  let sendInFlight = false;
  // Guards the single in-flight send: the token invalidates a stale settler
  // (flush callback / watchdog / rejectPending) so only the first one to fire
  // releases the slot; the watchdog handle lets rejectPending cancel it.
  let inFlightToken = 0;
  let inFlightWatchdog = null;
  const logPath = join(dataDir, 'channels-worker-standalone.log');
  // One-shot bound at own-process boot: this runtime may never pass through
  // the channels-worker rotation path, so cap the log writer-side.
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
  const useProcessWorker = process.env.MIXDOG_CHANNEL_WORKER_PROCESS !== '0';
  const clientDir = join(runtimeRoot(), 'channel-clients');
  const clientPath = join(clientDir, `${process.pid}.json`);
  let clientHeartbeatTimer = null;
  let clientHeartbeatExitCleanup = null;
  let clientDirReady = false;

  function writeClientHeartbeat() {
    // Must write every tick: liveness readers key off the file's rolling
    // mtime/updatedAt, so an unchanged-skip would make the client look dead.
    // mkdir once and write async to keep the 5s interval off the sync-fs path.
    try {
      if (!clientDirReady) {
        mkdirSync(clientDir, { recursive: true });
        clientDirReady = true;
      }
      writeFile(clientPath, JSON.stringify({
        pid: process.pid,
        cwd,
        updatedAt: Date.now(),
      }), () => {});
    } catch {}
  }

  function startClientHeartbeat() {
    if (clientHeartbeatTimer) return;
    writeClientHeartbeat();
    clientHeartbeatTimer = setInterval(writeClientHeartbeat, 5000);
    clientHeartbeatTimer.unref?.();
    clientHeartbeatExitCleanup ||= registerChannelWorkerExitCleanup(stopClientHeartbeat);
  }

  function stopClientHeartbeat() {
    if (clientHeartbeatExitCleanup) {
      const unregister = clientHeartbeatExitCleanup;
      clientHeartbeatExitCleanup = null;
      unregister();
    }
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer);
      clientHeartbeatTimer = null;
    }
    try { rmSync(clientPath, { force: true }); } catch {}
  }

  startClientHeartbeat();

  function status() {
    if (!useProcessWorker) {
      return {
        running: Boolean(inProcessMod),
        pid: inProcessMod ? process.pid : null,
        pending: 0,
        mode: 'in-process',
      };
    }
    return {
      running: Boolean(daemonClient),
      pid: daemonPid,
      pending: 0,
      mode: 'daemon',
    };
  }

  function rejectPending(error) {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    // Fail any sends still queued/in-flight for the now-dead channel so their
    // callers unblock instead of waiting on a flush callback that never fires.
    // Invalidate + disarm the in-flight watchdog so it can't later flip
    // sendInFlight under a freshly-started send (its owning call was already
    // rejected via the pending map above).
    inFlightToken++;
    if (inFlightWatchdog) { clearTimeout(inFlightWatchdog); inFlightWatchdog = null; }
    sendInFlight = false;
    while (sendQueue.length) {
      const item = sendQueue.shift();
      try { item.cb?.(error); } catch {}
    }
  }

  // Dispatch queued IPC sends one at a time, gating the next on the current
  // send's flush callback so child.send backpressure (false return) is honored.
  function drainSendQueue() {
    if (sendInFlight) return;
    const item = sendQueue.shift();
    if (!item) return;
    if (!child || !child.send) {
      try { item.cb?.(new Error('channels worker is not running')); } catch {}
      drainSendQueue();
      return;
    }
    sendInFlight = true;
    const token = ++inFlightToken;
    // Settle exactly once, whichever of {flush callback, watchdog} fires first;
    // a stale token (superseded by rejectPending or the sibling) is ignored.
    const finish = (error) => {
      if (token !== inFlightToken) return;
      inFlightToken++;
      if (inFlightWatchdog) { clearTimeout(inFlightWatchdog); inFlightWatchdog = null; }
      sendInFlight = false;
      try { item.cb?.(error); } catch {}
      drainSendQueue();
    };
    // Watchdog: if the flush callback never fires (wedged IPC channel), fail
    // this request via its normal rejection path and keep draining so a single
    // stuck send can't wedge the queue forever.
    inFlightWatchdog = setTimeout(() => finish(new Error('channels worker send timed out')), SEND_FLUSH_TIMEOUT_MS);
    inFlightWatchdog.unref?.();
    child.send(item.msg, (error) => finish(error));
  }

  function sendToChild(msg, cb) {
    sendQueue.push({ msg, cb });
    drainSendQueue();
  }

  function start() {
    if (!useProcessWorker) return startInProcess();
    // Daemon mode (default): spawn-or-attach to the machine-global channels
    // daemon. The fork code below is unreachable while useProcessWorker is true.
    return ensureDaemonAttached().then(() => status());
    if (stopPromise) {
      return stopPromise.then(() => start());
    }
    if (child && child.exitCode == null && !child.killed) return readyPromise || Promise.resolve(status());
    stopRequested = false;
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    spawnWorkerChild(1);
    return readyPromise;
  }

  function spawnWorkerChild(attempt) {
    const workerEnv = { ...process.env };
    scrubLoaderVars(workerEnv);
    child = fork(entry, [], {
      cwd,
      execArgv: ['--require', WORKER_PRELOAD],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: false,
      env: {
        ...workerEnv,
        MIXDOG_ROOT: rootDir,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_STANDALONE: '1',
        MIXDOG_WORKER_MODE: '1',
        MIXDOG_CLI_OWNED: '0',
        // Preserve the real terminal-lead PID (host TUI, or an outer run-mcp
        // supervisor if one injected MIXDOG_SUPERVISOR_PID) through the fork.
        // Without this the worker resolves getTerminalLeadPid() to its OWN pid,
        // so the seat's ownerLeadPid tracks the headless worker instead of the
        // terminal that owns it — and the seat can never be evicted when the
        // owning terminal/TUI dies while the worker stays alive.
        MIXDOG_SUPERVISOR_PID: process.env.MIXDOG_SUPERVISOR_PID || String(process.pid),
        MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
      },
      windowsHide: true,
    });
    const spawnedPid = child.pid;
    // Per-boot generation: a later start()/respawn bumps this, so a stale old
    // child's late exit is ignored instead of respawning/rejecting the current one.
    const myGeneration = ++bootGeneration;
    startChildGuardian({ childPid: spawnedPid, label: 'channel-worker', orphanGraceMs: 8000, forceGraceMs: 3000 });
    if (spawnedPid) ownedChildPids.add(spawnedPid);
    installParentExitHook();
    let becameReady = false;

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) logLine(logPath, text);
    });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        becameReady = true;
        readyResolve?.(status());
        readyResolve = null;
        readyReject = null;
        return;
      }
      if (msg.type === 'result' && msg.callId) {
        const item = pending.get(msg.callId);
        if (!item) return;
        pending.delete(msg.callId);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error));
        else item.resolve(msg.result);
        return;
      }
      if (msg.type === 'notify') {
        try { onNotify?.(msg); } catch {}
      }
    });

    child.on('exit', (code, signal) => {
      if (myGeneration !== bootGeneration) return;
      if (spawnedPid) ownedChildPids.delete(spawnedPid);
      const error = new Error(`channels runtime exited (${signal || (code ?? 'unknown')})`);
      // Exit code 2 = terminal (non-transient) worker start failure: reject, never respawn.
      // A requested stop (stopRequested) also suppresses respawn even if stopPromise's
      // settle timer already cleared it before the child exited.
      if (!becameReady && readyReject && !stopPromise && !stopRequested && code !== 2 && attempt < WORKER_BOOT_MAX_ATTEMPTS) {
        logLine(logPath, `worker exited before ready (${signal || (code ?? 'unknown')}), attempt ${attempt}/${WORKER_BOOT_MAX_ATTEMPTS}; retrying in ${WORKER_BOOT_RETRY_DELAY_MS}ms`);
        child = null;
        setTimeout(() => {
          if (stopPromise || stopRequested || !readyReject) return;
          spawnWorkerChild(attempt + 1);
        }, WORKER_BOOT_RETRY_DELAY_MS);
        return;
      }
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
      child = null;
      readyPromise = null;
    });

    child.on('error', (error) => {
      if (myGeneration !== bootGeneration) return;
      logLine(logPath, `runtime error: ${error?.message || error}`);
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
    });
  }

  async function startInProcess() {
    if (inProcessMod || inProcessStartPromise) return _startInProcess();
    // Singleton guard: in-process mode must not run a SECOND live bridge owner
    // beside the machine-global daemon (double Discord gateway). Claim the same
    // owner lock the daemon uses; if a LIVE daemon holds it, fail loudly rather
    // than silently double-own (unset MIXDOG_CHANNEL_WORKER_PROCESS=0 to attach).
    const claim = claimSingletonOwner(daemonOwnerPath, { kind: 'channel-runtime-daemon', pid: process.pid, meta: { cwd, mode: 'in-process' } });
    if (!claim.owned) {
      throw new Error(`in-process channels runtime refused: a live channels daemon (pid=${claim.owner?.pid}) already owns the bridge — refusing to double-own. Unset MIXDOG_CHANNEL_WORKER_PROCESS=0 to attach, or stop the daemon.`);
    }
    inProcessOwned = true;
    try {
      return await _startInProcess();
    } catch (err) {
      // Boot failed: release the just-claimed lock so a retry (or the daemon)
      // can own it instead of leaking a live lock held by a non-running runtime.
      if (inProcessOwned && !inProcessMod) {
        try { releaseSingletonOwner(daemonOwnerPath, process.pid); } catch {}
        inProcessOwned = false;
      }
      throw err;
    }
  }

  // ── Machine-global daemon: spawn-or-attach ────────────────────────────────
  // Second+ TUI attaches to the live daemon instead of forking. Discovery is a
  // pid-verified file (channel-daemon.json, 127.0.0.1 only). A stale daemon
  // (dead pid) or unhealthy one is respawned; a spawn race loser exits(0) so we
  // re-read discovery and attach to the winner (pid-verified singleton lock).
  const daemonLeadPid = Number(process.env.MIXDOG_SUPERVISOR_PID) || process.pid;
  const discoveryPath = join(runtimeRoot(), 'channel-daemon.json');
  function daemonDelay(ms) { return new Promise((r) => setTimeout(r, ms)); }
  // Same singleton owner file the daemon claims (dataDir-relative), so the
  // in-process fallback can refuse to run beside a live daemon.
  const daemonOwnerPath = join(dataDir, 'channel-daemon-owner.json');
  // Drop the cached attach so the next ensureDaemonAttached() re-reads discovery,
  // health-probes, and respawns a dead daemon — the recovery hinge for a daemon
  // restart mid-session (no TUI process restart needed).
  function invalidateDaemonClient(reason = 'invalidate', expected = null) {
    // CAS: only tear down when the live handle is still the one that failed, so
    // a concurrent call that already re-attached a fresh daemon isn't clobbered.
    if (expected && daemonClient !== expected) return;
    attachGeneration++;
    const client = daemonClient;
    daemonClient = null;
    attachPromise = null;
    daemonPid = null;
    if (client) { try { client.close(reason); } catch {} }
  }
  function daemonEnv() {
    const env = { ...process.env };
    scrubLoaderVars(env);
    return {
      ...env,
      MIXDOG_ROOT: rootDir,
      MIXDOG_DATA_DIR: dataDir,
      MIXDOG_STANDALONE: '1',
      MIXDOG_WORKER_MODE: '1',
      MIXDOG_CHANNEL_DAEMON: '1',
      MIXDOG_CLI_OWNED: '0',
      MIXDOG_SUPERVISOR_PID: process.env.MIXDOG_SUPERVISOR_PID || String(process.pid),
      MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
    };
  }
  // Fork one daemon candidate DETACHED (it outlives this TUI — machine-global)
  // and NEVER track it for parent-exit kill. Resolves when the candidate reports
  // ready OR exits (race loss/crash); the caller then re-checks discovery.
  function spawnDaemonCandidate() {
    return new Promise((resolveSpawn) => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolveSpawn(); };
      let daemon;
      try {
        daemon = fork(daemonEntry(), [], {
          cwd,
          execArgv: ['--require', WORKER_PRELOAD],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: daemonEnv(),
          ...detachedSpawnOpts,
        });
      } catch (err) {
        logLine(logPath, `daemon spawn failed: ${err?.message || err}`);
        done();
        return;
      }
      // Mirror daemon stderr into the shared log ONLY until it is ready. After
      // ready the daemon appends its own lines directly (channel-daemon.mjs), and
      // this TUI may exit at any time — a live mirror would both duplicate those
      // lines and die with the parent. Detach the listener at the ready boundary.
      const mirrorDaemonStderr = (chunk) => {
        const text = String(chunk || '').trimEnd();
        if (text) logLine(logPath, text);
      };
      daemon.stderr?.on('data', mirrorDaemonStderr);
      daemon.once('message', (msg) => {
        if (msg && msg.type === 'ready') {
          // Stop mirroring: the daemon now owns file logging (no loss, no dup).
          try { daemon.stderr?.off?.('data', mirrorDaemonStderr); } catch {}
          // Fully detach: the daemon must not be tied to this TUI's IPC/lifecycle.
          try { daemon.disconnect?.(); } catch {}
          try { daemon.unref?.(); } catch {}
          try { daemon.stderr?.unref?.(); } catch {}
          done();
        }
      });
      daemon.once('exit', done); // race loss (exit 0) or crash → re-check discovery
      daemon.once('error', (err) => { logLine(logPath, `daemon spawn error: ${err?.message || err}`); done(); });
      const t = setTimeout(done, 20_000);
      t.unref?.();
    });
  }
  function attachCancelledError() {
    const err = new Error('channels daemon attach superseded');
    err.daemonAttachCancelled = true;
    return err;
  }
  function discoveryMatchesHealth(discovery, health) {
    return Number(health?.pid) === Number(discovery?.pid);
  }
  async function doAttach(discovery, generation) {
    let client = null;
    let fatalDuringAttach = false;
    client = await attachToDaemon({
      discovery,
      leadPid: daemonLeadPid,
      cwd,
      onNotify: (msg) => { try { onNotify?.(msg); } catch {} },
      // A stale/dead SSE endpoint drops this attach immediately. Do not revive
      // it after this worker has explicitly stopped; otherwise proactively
      // re-read discovery so notifies resume without waiting for the next call.
      onFatal: () => {
        fatalDuringAttach = true;
        invalidateDaemonClient('sse fatal', client);
        if (!stopRequested) void ensureDaemonAttached().catch(() => {});
      },
      log: (line) => logLine(logPath, line),
    });
    if (stopRequested || generation !== attachGeneration || fatalDuringAttach) {
      await client.close('attach superseded');
      if (fatalDuringAttach && !stopRequested && generation === attachGeneration) {
        const err = attachCancelledError();
        err.daemonDiscoveryStale = true;
        throw err;
      }
      throw attachCancelledError();
    }
    daemonClient = client;
    daemonPid = discovery.pid;
    return client;
  }
  async function ensureDaemonAttached() {
    if (stopRequested) throw attachCancelledError();
    if (daemonClient) return daemonClient;
    if (attachPromise) return attachPromise;
    const generation = attachGeneration;
    const promise = (async () => {
      const deadline = Date.now() + 30_000;
      const MAX_AUTH_REJECTIONS = 5;
      let authRejections = 0;
      const retryStaleDiscovery = async (err) => {
        if (!err?.daemonAuthRejected) {
          await daemonDelay(200);
          return;
        }
        authRejections++;
        if (authRejections >= MAX_AUTH_REJECTIONS || Date.now() >= deadline) {
          throw new Error(`channels daemon register rejected discovery auth ${authRejections} times`);
        }
        await daemonDelay(Math.min(200 * (2 ** (authRejections - 1)), 2000));
      };
      for (let attempt = 0; ; attempt++) {
        if (stopRequested || generation !== attachGeneration) throw attachCancelledError();
        let discovery = readDaemonDiscovery(discoveryPath);
        if (discovery) {
          const health = await probeDaemonHealth({ port: discovery.port, token: discovery.token, timeoutMs: attempt === 0 ? 800 : 2000 });
          if (stopRequested || generation !== attachGeneration) throw attachCancelledError();
          if (discoveryMatchesHealth(discovery, health)) {
            try {
              return await doAttach(discovery, generation);
            } catch (err) {
              if (!err?.daemonDiscoveryStale) throw err;
              logLine(logPath, `daemon attach discovery stale: ${err.message}; re-reading`);
              await retryStaleDiscovery(err);
              continue;
            }
          }
          discovery = null; // published but unhealthy → respawn
        }
        // No live daemon (absent / dead pid / unhealthy): spawn a candidate. A
        // race loser exits(0); the winner publishes discovery we then attach to.
        await spawnDaemonCandidate();
        const after = readDaemonDiscovery(discoveryPath);
        if (after) {
          const health = await probeDaemonHealth({ port: after.port, token: after.token, timeoutMs: 3000 });
          if (stopRequested || generation !== attachGeneration) throw attachCancelledError();
          if (discoveryMatchesHealth(after, health)) {
            try {
              return await doAttach(after, generation);
            } catch (err) {
              if (!err?.daemonDiscoveryStale) throw err;
              logLine(logPath, `daemon attach discovery stale: ${err.message}; re-reading`);
              await retryStaleDiscovery(err);
              continue;
            }
          }
        }
        if (Date.now() > deadline) throw new Error('channels daemon did not become ready');
        await daemonDelay(200);
      }
    })();
    attachPromise = promise;
    try {
      return await promise;
    } finally {
      if (attachPromise === promise) attachPromise = null;
    }
  }
  async function _startInProcess() {
    if (inProcessMod) return status();
    if (inProcessStartPromise) return inProcessStartPromise;
    inProcessStartPromise = (async () => {
      process.env.MIXDOG_ROOT = rootDir;
      process.env.MIXDOG_DATA_DIR = dataDir;
      process.env.MIXDOG_STANDALONE ??= '1';
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod?.start !== 'function') throw new Error('channels runtime does not export start()');
      await mod.start();
      inProcessMod = mod;
      return status();
    })().finally(() => {
      inProcessStartPromise = null;
    });
    return inProcessStartPromise;
  }

  async function execute(name, args = {}, { timeoutMs = 120_000 } = {}) {
    if (!CHANNEL_TOOLS.has(name)) throw new Error(`unknown channel tool: ${name}`);
    await start();
    if (!useProcessWorker) {
      const call = inProcessMod?.handleToolCallWithBridgeRetry || inProcessMod?.handleToolCall;
      if (typeof call !== 'function') throw new Error('channels runtime is not running');
      let timer = null;
      try {
        return await Promise.race([
          call(name, args || {}),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`channels tool timed out: ${name}`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Daemon path: dispatch over HTTP with bounded re-attach so a daemon
    // death/restart is transparent — a transport failure drops the stale attach
    // and ensureDaemonAttached re-reads discovery + respawns-if-dead.
    let lastDaemonErr = null;
    // One stable callId for this logical call, reused across retries so the
    // daemon dedups a retried transport failure to a single side-effect.
    const logicalCallId = `ch_${proxyId}_${nextCallId++}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const daemon = await ensureDaemonAttached();
      try {
        return await daemon.call(name, args || {}, { timeoutMs, callId: logicalCallId });
      } catch (err) {
        if (!err?.daemonTransportError) throw err; // tool error → surface as-is
        lastDaemonErr = err;
        invalidateDaemonClient('transport failure', daemon);
        await daemonDelay(200 * (attempt + 1));
      }
    }
    throw lastDaemonErr || new Error('channels daemon call failed');
    if (!child || !child.send) throw new Error('channels worker is not running');
    const callId = `ch_${nextCallId++}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`channels tool timed out: ${name}`));
      }, timeoutMs);
      pending.set(callId, { resolve, reject, timer });
      sendToChild({ type: 'call', callId, name, args: args || {} }, (error) => {
        if (!error) return;
        pending.delete(callId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function forceKillTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  function forceKillTreeSync(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {}
      return;
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  function installParentExitHook() {
    if (parentExitCleanup) return;
    parentExitCleanup = registerChannelWorkerExitCleanup(() => {
      parentExitCleanup = null;
      for (const pid of Array.from(ownedChildPids)) {
        forceKillTreeSync(pid);
      }
      ownedChildPids.clear();
    });
  }

  function uninstallParentExitHook() {
    if (!parentExitCleanup) return;
    // Refcount-aware: never strip the shared parent-exit protection while any
    // owned child PID is still tracked. A newer worker may have been spawned
    // (new PID added, hook install is a no-op because it is already present)
    // before an older worker finishes its async teardown; letting that old
    // teardown uninstall here would leave the live newer PID unprotected.
    if (ownedChildPids.size > 0) return;
    const unregister = parentExitCleanup;
    parentExitCleanup = null;
    unregister();
  }

  function unrefChildHandles(target) {
    try { target?.unref?.(); } catch {}
    try { target?.stderr?.unref?.(); } catch {}
    try { target?.stdout?.unref?.(); } catch {}
    try { target?.stdin?.unref?.(); } catch {}
    try { target?.channel?.unref?.(); } catch {}
  }

  function stop(reason = 'standalone shutdown', options = {}) {
    const waitForExit = options?.waitForExit !== false;
    stopRequested = true;
    stopClientHeartbeat();
    if (stopPromise) return stopPromise;
    if (!useProcessWorker) {
      if (!inProcessMod && !inProcessStartPromise) {
        // Nothing running, but a lock may still be held if a prior boot claimed
        // then failed without clearing — release it so stop() never leaks it.
        if (inProcessOwned) { try { releaseSingletonOwner(daemonOwnerPath, process.pid); } catch {} inProcessOwned = false; }
        return Promise.resolve(false);
      }
      stopPromise = Promise.resolve(inProcessStartPromise)
        .catch(() => null)
        .then(async () => {
          try { await inProcessMod?.stop?.(reason); } catch {}
          inProcessMod = null;
          if (inProcessOwned) { try { releaseSingletonOwner(daemonOwnerPath, process.pid); } catch {} inProcessOwned = false; }
          return true;
        })
        .finally(() => {
          stopPromise = null;
        });
      return stopPromise;
    }
    // Daemon path: detach this TUI's client only. The shared daemon reaps
    // itself via client-grace once the last TUI leaves; never kill it here.
    if (useProcessWorker) {
      const inFlightAttach = attachPromise;
      attachGeneration++;
      const client = daemonClient;
      daemonClient = null;
      attachPromise = null;
      daemonPid = null;
      return Promise.all([
        client ? client.close(reason).then(() => true).catch(() => true) : Promise.resolve(false),
        Promise.resolve(inFlightAttach).catch(() => null),
      ]).then(([detached]) => detached);
    }
    if (!child) {
      return Promise.resolve(false);
    }
    const target = child;
    const targetPid = target.pid;
    child = null;
    if (!waitForExit) {
      rejectPending(new Error(`channels runtime shutdown requested (${reason})`));
      // Fast/detached path is still TERMINAL: the caller does not block on the
      // full teardown, but a background escalation ladder guarantees the worker
      // dies so no zombie survives. Exit-hook + PID tracking stay installed
      // until the process ACTUALLY exits (not on IPC ack), so a parent that
      // force-exits mid-grace still force-kills the tree via the exit cleanup.
      let torn = false;
      const teardown = () => {
        if (torn) return;
        torn = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        if (targetPid) ownedChildPids.delete(targetPid);
        unrefChildHandles(target);
        uninstallParentExitHook();
      };
      // Bounded grace after IPC shutdown, then SIGTERM.
      const termTimer = setTimeout(() => {
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGTERM');
        } catch {}
      }, 1500);
      // Hard fallback: taskkill /T /F the whole tree, then SIGKILL the handle.
      const killTimer = setTimeout(() => {
        try {
          if (target.exitCode == null) forceKillTree(targetPid);
        } catch {}
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGKILL');
        } catch {}
        teardown();
      }, 3000);
      // Unref so these background escalation timers never keep the event loop
      // (or a pending /exit) alive waiting out the grace/hard-kill window.
      termTimer.unref?.();
      killTimer.unref?.();
      // Actual exit (or spawn error) is the only thing that tears down tracking.
      target.once('exit', teardown);
      target.once('error', teardown);
      stopPromise = new Promise((resolve) => {
        let settled = false;
        const settle = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(sendTimer);
          stopPromise = null;
          resolve(ok);
        };
        // Resolve the caller quickly once the IPC shutdown is acked/timed out;
        // the escalation ladder above keeps running in the background.
        const sendTimer = setTimeout(() => settle(true), 250);
        sendTimer.unref?.();
        target.once('exit', () => settle(true));
        try {
          target.send?.({ type: 'shutdown', reason }, () => {
            try { target.disconnect?.(); } catch {}
            settle(true);
          });
        } catch {
          try { target.disconnect?.(); } catch {}
          // IPC unavailable: skip the grace window and escalate now.
          try {
            if (target.exitCode == null && !target.killed) target.kill('SIGTERM');
          } catch {}
          settle(false);
        }
      });
      return stopPromise;
    }
    stopPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        stopPromise = null;
        uninstallParentExitHook();
        resolve(ok);
      };
      const termTimer = setTimeout(() => {
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGTERM');
        } catch {}
      }, 1500);
      const killTimer = setTimeout(() => {
        try {
          if (target.exitCode == null) forceKillTree(targetPid);
        } catch {}
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGKILL');
        } catch {}
        finish(false);
      }, 5000);
      target.once('exit', () => finish(true));
      target.once('error', () => finish(false));
      try {
        target.send?.({ type: 'shutdown', reason }, () => {
          try { target.disconnect?.(); } catch {}
        });
      } catch {
        try { target.disconnect?.(); } catch {}
      }
    });
    return stopPromise;
  }

  return {
    start,
    execute,
    stop,
    status,
    isChannelTool: (name) => CHANNEL_TOOLS.has(name),
  };
}
