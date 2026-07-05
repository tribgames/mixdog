import { execFile, fork, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startChildGuardian } from '../runtime/shared/child-guardian.mjs';
import { appendBuffered } from '../runtime/shared/buffered-appender.mjs';
import { scrubLoaderVars } from '../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';

const CHANNEL_TOOLS = new Set([
  'reply',
  'fetch',
  // activate_channel_bridge/reload_config are NOT model-facing tools (no
  // TOOL_DEFS entry) but stay in the allow-set: mixdog-session-runtime.mjs
  // calls channels.execute() with these names directly as internal
  // Lead-only runtime plumbing (bridge-claim on start, config hot-reload).
  'activate_channel_bridge',
  'reload_config',
]);

const WORKER_PRELOAD = fileURLToPath(new URL('./channel-worker-preload.cjs', import.meta.url));

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
  let nextCallId = 1;
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
      running: Boolean(child && child.exitCode == null && !child.killed),
      pid: child?.pid || null,
      pending: pending.size,
      mode: 'runtime',
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
        return Promise.resolve(false);
      }
      stopPromise = Promise.resolve(inProcessStartPromise)
        .catch(() => null)
        .then(async () => {
          try { await inProcessMod?.stop?.(reason); } catch {}
          inProcessMod = null;
          return true;
        })
        .finally(() => {
          stopPromise = null;
        });
      return stopPromise;
    }
    if (!child) {
      return Promise.resolve(false);
    }
    const target = child;
    const targetPid = target.pid;
    child = null;
    if (!waitForExit) {
      rejectPending(new Error(`channels runtime shutdown requested (${reason})`));
      if (targetPid) ownedChildPids.delete(targetPid);
      stopPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(sendTimer);
          stopPromise = null;
          unrefChildHandles(target);
          uninstallParentExitHook();
          resolve(ok);
        };
        const sendTimer = setTimeout(() => finish(false), 250);
        try {
          target.send?.({ type: 'shutdown', reason }, () => {
            try { target.disconnect?.(); } catch {}
            finish(true);
          });
        } catch {
          try { target.disconnect?.(); } catch {}
          finish(false);
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
