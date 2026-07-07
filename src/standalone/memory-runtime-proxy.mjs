import { fork } from 'node:child_process';
import { detachedSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { claimSingletonOwner, handoffSingletonOwner, readSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { readLiveServiceAdvert } from '../runtime/shared/service-discovery.mjs';
import { scrubLoaderVars } from '../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT ? resolve(process.env.MIXDOG_RUNTIME_ROOT) : join(tmpdir(), 'mixdog');
}

function activeInstancePath() {
  return join(runtimeRoot(), 'active-instance.json');
}

function readActiveInstance() {
  try {
    return JSON.parse(readFileSync(activeInstancePath(), 'utf8'));
  } catch {
    return null;
  }
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function parsePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid) {
  const n = parsePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TRANSIENT_MEMORY_RPC_BACKOFF_MS = 400;
// A child that dies during startup with one of these signatures is a hard,
// deterministic failure (bad entry path, syntax/require error) — never a
// transient owner-lock race. Surface it fast instead of burning the ready-wait.
function looksLikeStartupCrash(text) {
  // Only genuinely deterministic loader/parse failures. Runtime errors like
  // TypeError/ReferenceError can be transient init races — matching them would
  // poison crashState and cache a hard failure for a recoverable spawn.
  return /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/i.test(String(text || ''));
}
// Once a spawn crashes deterministically, short-circuit re-forks for this
// window so a persistent crash-loop returns the cached reason immediately
// instead of paying spawn+ready-wait on every call.
const MEMORY_CRASH_COOLDOWN_MS = Math.max(0, Number(process.env.MIXDOG_MEMORY_CRASH_COOLDOWN_MS) || 30_000);

function isConnResetLikeError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || /ECONNRESET|socket hang up/i.test(msg);
}

function isMemoryWorkerNotReadyError(err) {
  const msg = String(err?.message || err || '');
  return /memory worker exited before ready|memory worker ready timeout|memory runtime did not become ready|memory worker degraded|memory worker draining/i.test(msg);
}

function isTransientMemoryRpcError(err) {
  return isConnResetLikeError(err) || isMemoryWorkerNotReadyError(err);
}

function isMemoryReadOnlyToolCall(name, args = {}) {
  const tool = String(name || '').trim();
  if (tool === 'recall' || tool === 'search_memories') return true;
  if (tool !== 'memory') return false;
  const action = String(args?.action || '').trim();
  if (action === 'status') return true;
  if (action === 'core') {
    const op = String(args?.op || '').trim();
    return op === 'list' || op === 'candidates';
  }
  return false;
}

function requestJson({ port, method = 'GET', path = '/', body = null, timeoutMs = 10_000, headers = {} }) {
  return new Promise((resolvePromise, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode && res.statusCode >= 400) {
          const message = parsed?.error
            || parsed?.content?.[0]?.text
            || data
            || `HTTP ${res.statusCode}`;
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        resolvePromise(parsed ?? { raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`memory proxy request timed out: ${method} ${path}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function createStandaloneMemoryRuntime({
  entry,
  dataDir,
  cwd = process.cwd(),
} = {}) {
  if (!entry) throw new Error('memory runtime entry is required');
  if (!dataDir) throw new Error('memory runtime dataDir is required');

  const logPath = join(dataDir, 'memory-runtime-proxy.log');
  // One-shot bound at own-process boot: this runtime may never pass through
  // the channels-worker rotation path, so cap the log writer-side.
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
  const ownerPath = join(dataDir, 'memory-runtime-owner.json');
  const singletonEnabled = process.env.MIXDOG_MEMORY_SINGLETON !== '0';
  const idleTtlMs = Math.max(0, Number(process.env.MIXDOG_MEMORY_IDLE_TTL_MS) || 10 * 60_000);
  let portCache = null;
  let startPromise = null;
  let child = null;
  let nextCallId = 1;
  let crashState = null; // { reason, at } — cached deterministic spawn crash
  // Port we have registered this proxy pid with (so the shared daemon can
  // reap itself promptly once every client deregisters). Re-registers when
  // the daemon respawns on a new port.
  let registeredWithPort = null;

  async function ensureClientRegistered(port) {
    // Returns the port the pending RPC should target. When an internal respawn
    // happens the daemon moves to a fresh port, so the caller MUST use the
    // returned value rather than the port it captured before registering.
    if (!port || registeredWithPort === port) return port;
    // The register RPC is provably side-effect-free from the caller's point of
    // view: a refused/reset connection means the daemon never received it, and
    // a draining 503 means it refused it. So a register-phase transient is ALWAYS
    // safe to recover from by respawning a fresh daemon and retrying — even for a
    // pending WRITE RPC. We do that respawn-and-retry HERE, before the write RPC
    // is ever attempted, rather than leaning on the outer retry (which must not
    // blanket-retry refused/reset on the write RPC itself).
    let curPort = port;
    for (let attempt = 0; ; attempt++) {
      try {
        await requestJson({
          port: curPort,
          method: 'POST',
          path: '/client/register',
          body: { clientPid: process.pid },
          timeoutMs: 2000,
        });
        registeredWithPort = curPort;
        return curPort;
      } catch (err) {
        // Benign failures (e.g. request timeout against a busy-but-live daemon)
        // are not fatal: registration is best-effort and the idle TTL backstops
        // a missed register. Only recover from genuine "daemon is gone/dying".
        if (!isTransientMemoryRpcError(err)) return curPort;
        if (attempt >= 3) throw err;
        invalidateMemoryRuntimeAfterTransient(err);
        await delay(TRANSIENT_MEMORY_RPC_BACKOFF_MS);
        const started = await start();
        curPort = started.port;
      }
    }
  }

  async function deregisterClient() {
    const port = registeredWithPort || portCache;
    registeredWithPort = null;
    if (!port) return;
    try {
      await requestJson({
        port,
        method: 'POST',
        path: '/client/deregister',
        body: { clientPid: process.pid },
        timeoutMs: 1500,
      });
    } catch { /* best-effort; sweep + idle TTL reap us anyway */ }
  }

  function invalidateMemoryRuntimeAfterTransient(err) {
    portCache = null;
    registeredWithPort = null;
    if (!isMemoryWorkerNotReadyError(err)) return;
    startPromise = null;
    const proc = child;
    child = null;
    if (!proc || proc.killed) return;
    try { proc.kill(); } catch {}
  }

  function shouldRetryMemoryRpcError(err, { readOnlyRpc = false } = {}) {
    if (isMemoryWorkerNotReadyError(err)) return true;
    if (readOnlyRpc && isConnResetLikeError(err)) return true;
    return false;
  }

  async function withTransientMemoryRpcRetry(run, { readOnlyRpc = false } = {}) {
    try {
      return await run();
    } catch (err) {
      if (!shouldRetryMemoryRpcError(err, { readOnlyRpc })) throw err;
      invalidateMemoryRuntimeAfterTransient(err);
      await delay(TRANSIENT_MEMORY_RPC_BACKOFF_MS);
      return await run();
    }
  }

  async function findLivePort({ allowStarting = false } = {}) {
    // Prefer the single-writer discovery advert (discovery/memory.json); the
    // legacy active-instance.json memory_port/memory_server_pid fields remain a
    // cross-version fallback when no discovery advert is present.
    const advert = readLiveServiceAdvert('memory', { requirePid: false });
    const active = advert ? null : readActiveInstance();
    const port = advert ? parsePort(advert.port) : parsePort(active?.memory_port);
    if (!port) return null;
    const ownerPid = advert ? parsePid(advert.pid) : parsePid(active?.memory_server_pid);
    // A dead server pid means the published memory_port is stale — the daemon
    // that owned it is gone. Clearing portCache here (and letting the caller
    // re-claim + respawn) prevents the stale port from wedging recovery.
    if (ownerPid && !isPidAlive(ownerPid)) { portCache = null; return null; }
    try {
      const health = await requestJson({ port, path: '/health', timeoutMs: allowStarting ? 2000 : 500 });
      if (health?.status === 'ok' || (allowStarting && health?.status === 'starting')) {
        portCache = port;
        return port;
      }
      // Reachable but not healthy: treat the cached/published port as stale so
      // start() falls through to (re)claim the singleton and respawn instead of
      // trusting a half-dead port.
      portCache = null;
    } catch {}
    // Health probe failed (ECONNREFUSED / timeout) against a published port.
    // Drop the cache AND, when the on-disk owner is a dead pid, release it so
    // a fresh claimOwner() in start() is not blocked by a corpse owner file.
    portCache = null;
    if (singletonEnabled) {
      const owner = readSingletonOwner(ownerPath);
      if (owner.owner && !owner.alive) {
        try { releaseSingletonOwner(ownerPath, parsePid(owner.owner.pid) ?? process.pid); } catch {}
      }
    }
    return null;
  }

  async function waitForPort(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const port = await findLivePort({ allowStarting: true });
      if (port) {
        try {
          const health = await requestJson({ port, path: '/health', timeoutMs: 1500 });
          if (health?.status === 'ok') return port;
        } catch (error) {
          lastError = error;
        }
      }
      await delay(100);
    }
    throw lastError || new Error('memory runtime did not become ready');
  }

  function claimOwner() {
    if (!singletonEnabled) return { owned: true, owner: { pid: process.pid } };
    return claimSingletonOwner(ownerPath, {
      kind: 'memory-runtime-daemon',
      pid: process.pid,
      meta: { cwd, clientPid: process.pid },
    });
  }

  function releaseOwnerIfSelf() {
    if (!singletonEnabled) return;
    releaseSingletonOwner(ownerPath, process.pid);
  }

  async function start() {
    if (portCache) {
      const port = await findLivePort();
      if (port) { crashState = null; return { running: true, port, mode: 'http-proxy' }; }
      portCache = null;
    }
    const existing = await findLivePort();
    if (existing) { crashState = null; return { running: true, port: existing, mode: 'http-proxy' }; }
    // Persistent crash-loop guard: no live daemon and a recent deterministic
    // spawn crash → fail fast with the cached reason, don't re-fork per call.
    // But a healthy singleton owner may be mid-boot and not yet advertising a
    // port; probe/await it before trusting cached crashState so a recovering
    // daemon isn't handed a stale hard failure.
    if (crashState && Date.now() - crashState.at < MEMORY_CRASH_COOLDOWN_MS) {
      if (singletonEnabled) {
        const owner = readSingletonOwner(ownerPath);
        if (owner.alive) {
          const live = await waitForPort(15_000);
          crashState = null;
          return { running: true, port: live, mode: 'http-proxy' };
        }
      }
      throw new Error(crashState.reason);
    }
    if (startPromise) {
      const port = await startPromise;
      return { running: true, port, mode: 'http-proxy' };
    }

    startPromise = (async () => {
      let claim = claimOwner();
      if (!claim.owned) {
        // Another owner holds the singleton. If it is live AND serving a
        // healthy port, use it. If it is live but NOT healthy (a daemon that is
        // draining/shutting down never revives — see getDraining/health in
        // lib/http-router.mjs), poll: reclaim the instant the old owner exits so
        // a quick restart still ends with a fresh, working daemon instead of
        // binding to the dying one and failing the pending RPC.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const livePort = await findLivePort({ allowStarting: true });
          if (livePort) {
            try {
              const health = await requestJson({ port: livePort, path: '/health', timeoutMs: 1500 });
              if (health?.status === 'ok') return livePort;
            } catch { /* dying/unreachable — fall through to reclaim */ }
          }
          const reclaim = claimOwner();
          if (reclaim.owned) { claim = reclaim; break; }
          await delay(150);
        }
        if (!claim.owned) {
          const owner = readSingletonOwner(ownerPath);
          if (owner.alive) throw new Error('memory runtime did not become ready');
          releaseOwnerIfSelf();
          claim = claimOwner();
          if (!claim.owned) throw new Error('memory runtime did not become ready');
        }
      }

      const daemonEnv = { ...process.env };
      delete daemonEnv.MIXDOG_QUIET_MEMORY_LOG;
      scrubLoaderVars(daemonEnv);
      child = fork(entry, [], {
        cwd,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...daemonEnv,
          MIXDOG_DATA_DIR: dataDir,
          MIXDOG_WORKER_MODE: '1',
          MIXDOG_STANDALONE: '1',
          MIXDOG_SERVER_PID: '',
          MIXDOG_OWNER_LEAD_PID: String(process.pid),
          MIXDOG_MEMORY_SECONDARY: '0',
          MIXDOG_PG_ATTACH_ONLY: '0',
          // seeds.mjs defaults MIXDOG_EMBED_WARMUP to '0' for the HOST process
          // (TUI boot must not pay the ONNX session-create cost). The daemon is
          // the long-lived embed owner, so warmup is force-enabled here like the
          // secondary/attach flags above — otherwise the daemon boots cold and
          // every recall runs lexical-only until the first fallback flush
          // lazily loads the model (observed 1.5h '(no results)' windows).
          MIXDOG_EMBED_WARMUP: '1',
          MIXDOG_MEMORY_DISABLE_CYCLES: process.env.MIXDOG_MEMORY_DISABLE_CYCLES ?? '0',
          MIXDOG_MEMORY_DISABLE_LLM_WORKER: process.env.MIXDOG_MEMORY_DISABLE_LLM_WORKER ?? '0',
          MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
          MIXDOG_MEMORY_DAEMON: '1',
          MIXDOG_MEMORY_IDLE_TTL_MS: String(idleTtlMs),
        },
        ...detachedSpawnOpts,
      });
      const childPid = child.pid;
      if (singletonEnabled && childPid) {
        // Atomic parent->child handoff under the claim lock. A plain
        // release()+claim() opened a window where a concurrent proxy could
        // claim + fork a competing daemon; the loser child then died on the
        // owner lock and its ready promise rejected instead of falling back.
        handoffSingletonOwner(ownerPath, process.pid, {
          kind: 'memory-runtime-daemon',
          pid: childPid,
          meta: { cwd, launcherPid: process.pid },
        });
      }
      let stderrTail = '';
      child.stderr?.on('data', chunk => {
        const text = String(chunk || '');
        const trimmed = text.trimEnd();
        if (trimmed) logLine(logPath, trimmed);
        stderrTail = (stderrTail + text).slice(-4000);
      });
      child.on('exit', () => {
        if (singletonEnabled && childPid) releaseSingletonOwner(ownerPath, childPid);
        if (child?.pid === childPid) child = null;
        portCache = null;
        registeredWithPort = null;
      });

      const ready = new Promise((resolveReady, rejectReady) => {
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
          const tail = stderrTail.trim().split('\n').slice(-8).join('\n');
          const detail = tail ? `: ${tail}` : '';
          const err = new Error(`memory worker exited before ready (${signal || code || 'unknown'})${detail}`);
          err.stderrTail = tail;
          rejectReady(err);
        });
      });

      try {
        await ready;
      } catch (err) {
        // A deterministic startup crash (bad entry path -> MODULE_NOT_FOUND,
        // syntax/require errors) is not an owner-lock race: cache the reason
        // for the cooldown window and fail immediately with the stderr tail
        // instead of burning waitForPort() on a child that will never publish.
        const msg = String(err?.message || err || '');
        if (looksLikeStartupCrash(err?.stderrTail || msg)) {
          crashState = { reason: msg, at: Date.now() };
          throw err;
        }
        // Loser fallback: two proxies (TUI host vs channels worker) can race to
        // fork; the child that lost the owner-lock exits before ready. Instead
        // of propagating "exited before ready" (which would surface as no
        // daemon), wait for the WINNER's daemon to publish a live port and use
        // it. Only rethrow if no live daemon appears in the window.
        const raceLoss = /exited before ready|degraded|ready timeout|owner lock|lock/i.test(msg);
        if (!raceLoss) throw err;
        return await waitForPort(30_000);
      }
      const port = await waitForPort(15_000);
      crashState = null;
      try { child.disconnect?.(); } catch {}
      try { child.unref?.(); } catch {}
      try { child.stderr?.unref?.(); } catch {}
      return port;
    })().finally(() => {
      startPromise = null;
    });

    const port = await startPromise;
    return { running: true, port, mode: 'http-proxy' };
  }

  async function handleToolCall(name, args = {}) {
    const readOnlyRpc = isMemoryReadOnlyToolCall(name, args);
    const callId = `mem_${process.pid}_${nextCallId++}`;
    return await withTransientMemoryRpcRetry(async () => {
      await start();
      let port = portCache || await findLivePort({ allowStarting: true });
      if (!port) throw new Error('memory runtime is not available');
      // ensureClientRegistered may respawn onto a fresh daemon/port; target the
      // port it hands back so the RPC and registration always hit the same one.
      port = await ensureClientRegistered(port);
      if (!port) throw new Error('memory runtime is not available');
      return await requestJson({
        port,
        method: 'POST',
        path: '/api/tool',
        body: { name, arguments: args || {} },
        timeoutMs: Math.max(1000, Number(process.env.MIXDOG_MEMORY_TOOL_TIMEOUT_MS) || 180_000),
        headers: { 'X-Mixdog-Call-Id': callId },
      });
    }, { readOnlyRpc });
  }

  async function buildSessionCoreMemoryPayload(sessionCwd) {
    return await withTransientMemoryRpcRetry(async () => {
      await start();
      let port = portCache || await findLivePort({ allowStarting: true });
      if (!port) throw new Error('memory runtime is not available');
      port = await ensureClientRegistered(port);
      if (!port) throw new Error('memory runtime is not available');
      return await requestJson({
        port,
        method: 'POST',
        path: '/session-start/core-memory',
        body: { cwd: sessionCwd || cwd },
        timeoutMs: 30_000,
      });
    }, { readOnlyRpc: true });
  }

  async function stop() {
    // Deregister this client so a shared daemon can reap itself within the
    // seconds-scale client grace once no clients remain, then detach. We never
    // hard-kill the daemon here — another tab/session may still be using it.
    await deregisterClient();
    try { child?.disconnect?.(); } catch {}
    try { child?.unref?.(); } catch {}
    child = null;
    return true;
  }

  async function status() {
    const port = await findLivePort();
    const owner = readSingletonOwner(ownerPath);
    return {
      running: Boolean(port),
      port,
      mode: 'http-proxy',
      ownerPid: parsePid(owner.owner?.pid),
      ownerAlive: owner.alive,
    };
  }

  return {
    init: start,
    start,
    stop,
    status,
    handleToolCall,
    buildSessionCoreMemoryPayload,
    moduleUrl: pathToFileURL(entry).href,
  };
}
