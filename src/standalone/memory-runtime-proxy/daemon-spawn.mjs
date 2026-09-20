import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { detachedSpawnOpts } from '../../runtime/shared/spawn-flags.mjs';
import { withHeapCap } from '../../runtime/shared/heap-cap.mjs';
import { resolveRuntimeRoot } from '../../runtime/shared/runtime-root.mjs';
import { scrubLoaderVars } from '../../runtime/agent/orchestrator/tools/env-scrub.mjs';

// Once a spawn crashes deterministically, short-circuit re-forks for this
// window so a persistent crash-loop returns the cached reason immediately
// instead of paying spawn+ready-wait on every call.
export const MEMORY_CRASH_COOLDOWN_MS = Math.max(0, Number(process.env.MIXDOG_MEMORY_CRASH_COOLDOWN_MS) || 30_000);

// A child that dies during startup with one of these signatures is a hard,
// deterministic failure (bad entry path, syntax/require error) — never a
// transient owner-lock race. Only genuinely deterministic loader/parse
// failures: TypeError/ReferenceError can be transient init races, and
// matching them would cache a hard failure for a recoverable spawn.
function looksLikeStartupCrash(text) {
  return /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/i.test(String(text || ''));
}

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function daemonEnv({ dataDir, idleTtlMs }) {
  const env = { ...process.env };
  delete env.MIXDOG_QUIET_MEMORY_LOG;
  scrubLoaderVars(env);
  return {
    ...env,
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_RUNTIME_ROOT: resolveRuntimeRoot(),
    MIXDOG_WORKER_MODE: '1',
    MIXDOG_STANDALONE: '1',
    MIXDOG_SERVER_PID: '',
    MIXDOG_OWNER_LEAD_PID: String(process.pid),
    MIXDOG_MEMORY_SECONDARY: '0',
    MIXDOG_PG_ATTACH_ONLY: '0',
    // The daemon owns the model, but ownership does not imply eager residency.
    // A recall starts warmup on demand and immediately uses lexical search
    // while it loads, keeping desktop/TUI boot lightweight.
    MIXDOG_EMBED_WARMUP: process.env.MIXDOG_EMBED_WARMUP ?? '0',
    MIXDOG_MEMORY_DISABLE_CYCLES: process.env.MIXDOG_MEMORY_DISABLE_CYCLES ?? '0',
    MIXDOG_MEMORY_DISABLE_LLM_WORKER: process.env.MIXDOG_MEMORY_DISABLE_LLM_WORKER ?? '0',
    MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
    MIXDOG_MEMORY_DAEMON: '1',
    MIXDOG_MEMORY_IDLE_TTL_MS: String(idleTtlMs),
  };
}

// Resolves on the child's first IPC message, rejects on a degraded/error
// message, a spawn error, an exit before ready (with the stderr tail) or a
// 60s ready timeout.
function awaitReady(child, readStderrTail) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('memory worker ready timeout')), 60_000);
    child.once('message', (msg) => {
      clearTimeout(timer);
      if (msg?.degraded || msg?.error) rejectReady(new Error(msg.error || 'memory worker degraded'));
      else resolveReady(msg);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const tail = readStderrTail().trim().split('\n').slice(-8).join('\n');
      const detail = tail ? `: ${tail}` : '';
      const err = new Error(`memory worker exited before ready (${signal || code || 'unknown'})${detail}`);
      err.stderrTail = tail;
      rejectReady(err);
    });
  });
}

// Drop the parent's handles on the daemon so it outlives this process.
export function releaseChildHandle(child) {
  try {
    child?.disconnect?.();
  } catch {}
  try {
    child?.unref?.();
  } catch {}
}

export function createDaemonSpawner({ state, entry, dataDir, cwd, idleTtlMs, logPath, ownerClaim, discovery }) {
  function forkDaemon() {
    return fork(entry, [], {
      cwd,
      execArgv: withHeapCap('memory'),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: daemonEnv({ dataDir, idleTtlMs }),
      ...detachedSpawnOpts,
    });
  }
  // Mirror stderr into the proxy log, keep a bounded tail for crash reports,
  // and release the owner claim + cached port when the child exits.
  function attachChildLifecycle(child) {
    const childPid = child.pid;
    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '');
      const trimmed = text.trimEnd();
      if (trimmed) logLine(logPath, trimmed);
      stderrTail = (stderrTail + text).slice(-4000);
    });
    child.on('exit', () => {
      ownerClaim.releaseChild(childPid);
      if (state.child?.pid === childPid) state.child = null;
      state.portCache = null;
      state.registeredWithPort = null;
    });
    return () => stderrTail;
  }
  async function recoverFromReadyFailure(err) {
    // A deterministic startup crash (bad entry path -> MODULE_NOT_FOUND,
    // syntax/require errors) is not an owner-lock race: cache the reason for
    // the cooldown window and fail immediately with the stderr tail instead
    // of burning waitForPort() on a child that will never publish.
    const msg = String(err?.message || err || '');
    if (looksLikeStartupCrash(err?.stderrTail || msg)) {
      state.crashState = { reason: msg, at: Date.now() };
      throw err;
    }
    // Loser fallback: two proxies (TUI host vs channels worker) can race to
    // fork; the child that lost the owner-lock exits before ready. Wait for
    // the WINNER's daemon to publish a live port instead of surfacing "exited
    // before ready" as no daemon; rethrow only if none appears in the window.
    const raceLoss = /exited before ready|degraded|ready timeout|owner lock|lock/i.test(msg);
    if (!raceLoss) throw err;
    return await discovery.waitForPort(30_000);
  }
  async function spawnDaemon() {
    const child = forkDaemon();
    state.child = child;
    ownerClaim.handoffToChild(child.pid);
    const readStderrTail = attachChildLifecycle(child);
    try {
      await awaitReady(child, readStderrTail);
    } catch (err) {
      return await recoverFromReadyFailure(err);
    }
    const port = await discovery.waitForPort(15_000);
    state.crashState = null;
    releaseChildHandle(child);
    try {
      child.stderr?.unref?.();
    } catch {}
    return port;
  }
  return { spawnDaemon };
}
