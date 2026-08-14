// Resident native search: forwards rg-style windowed line requests to ONE
// long-lived `mixdog-graph --serve-search` process. The server embeds the
// ripgrep matcher/searcher/printer crates and is the only local-search backend.
// Unsupported requests and server failures are explicit errors at the caller.
// MIXDOG_SEARCH_SERVER=0 disables; MIXDOG_SEARCH_SERVER_BIN overrides the
// binary (dev builds).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { getPluginData } from '../../config.mjs';
import { ensureGraphBinary } from '../graph-binary-fetcher.mjs';

const RESTART_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_READY_TIMEOUT_MS = 1_000;

let _server = null; // { child, pending: Map, sequence }
let _binaryPath = undefined; // undefined = unresolved, null = unavailable
let _lastFailureAt = 0;
let _binaryResolveStarted = false;
let _warmPromise = null;

function _setServerReferenced(server, referenced) {
  const method = referenced ? 'ref' : 'unref';
  try { server?.child?.[method]?.(); } catch {}
  try { server?.child?.stdin?.[method]?.(); } catch {}
  try { server?.child?.stdout?.[method]?.(); } catch {}
}

function _resolveBinary() {
  if (_binaryPath !== undefined) return _binaryPath;
  // The graph and resident-search protocols ship in the same executable.
  // Honor either override synchronously so a first grep never races the lazy
  // graph module import while an explicitly injected binary already exists.
  const explicit = String(
    process.env.MIXDOG_SEARCH_SERVER_BIN
    || process.env.MIXDOG_GRAPH_BIN
    || '',
  ).trim();
  if (explicit && existsSync(explicit)) {
    _binaryPath = explicit;
    return _binaryPath;
  }
  if (!_binaryResolveStarted) {
    _binaryResolveStarted = true;
    // Reuse the code-graph binary resolution lazily; resolver shape is duck-
    // typed so a refactor there degrades to "server unavailable", never throws.
    void import('../code-graph/graph-binary.mjs').then((mod) => {
      try {
        const candidate = mod.graphBinaryPath?.() || mod.resolveGraphBinaryPath?.() || null;
        _binaryPath = (candidate && existsSync(candidate)) ? candidate : null;
      } catch {
        _binaryPath = null;
      }
    }).catch(() => {
      _binaryPath = null;
    });
  }
  return _binaryPath;
}

function _teardown(error) {
  const server = _server;
  _server = null;
  _lastFailureAt = Date.now();
  if (!server) return;
  for (const pending of server.pending.values()) {
    try { pending.reject(error || new Error('native search server exited')); } catch {}
  }
  server.pending.clear();
  try { server.resolveReady?.(false); } catch {}
  try { server.child.kill(); } catch {}
}

export function _bindNativeSearchServerLifecycle(child, { onError, onExit } = {}) {
  if (!child?.on) return;
  child.on('error', onError);
  child.on('exit', onExit);
  // ChildProcess stdin emits write failures asynchronously. A sync try/catch
  // around stdin.write cannot catch EPIPE; without this listener the session
  // shard itself terminates and every active/queued turn is crash-recovered.
  child.stdin?.on?.('error', onError);
}

function _ensureServer() {
  if (_server) return _server;
  if (Date.now() - _lastFailureAt < RESTART_BACKOFF_MS) return null;
  const binary = _resolveBinary();
  if (!binary) return null;
  let child;
  try {
    child = spawn(binary, [process.cwd(), '--serve-search'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...hiddenSpawnOpts,
    });
  } catch {
    _lastFailureAt = Date.now();
    return null;
  }
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const server = {
    child,
    pending: new Map(),
    sequence: 0,
    timeoutStreak: 0,
    ready,
    readyState: false,
    readyWaiters: 0,
    resolveReady,
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.ready === true) {
      server.readyState = true;
      server.resolveReady?.(true);
      return;
    }
    if (message?.event === 'invalidate' && Array.isArray(message.paths)) {
      invalidateBuiltinResultCache(message.paths.map(String));
      return;
    }
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    server.pending.delete(Number(message.id));
    server.timeoutStreak = 0;
    pending.resolve(message);
  });
  _bindNativeSearchServerLifecycle(child, {
    onError: (error) => { if (_server === server) _teardown(error); },
    onExit: () => { if (_server === server) _teardown(); },
  });
  // A detached child can still pin a one-shot CLI/test through its pipe
  // handles. Keep the resident server idle-unreferenced, then ref all handles
  // only while a request is awaiting a response.
  _setServerReferenced(server, false);
  _server = server;
  return server;
}

async function _waitServerReady(server, timeoutMs = 5_000) {
  if (!server) return false;
  if (server.readyState) return true;
  server.readyWaiters += 1;
  _setServerReferenced(server, true);
  let timer;
  try {
    return await Promise.race([
      server.ready,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]) === true;
  } finally {
    if (timer) clearTimeout(timer);
    server.readyWaiters = Math.max(0, server.readyWaiters - 1);
    if (server.readyWaiters === 0 && server.pending.size === 0) {
      _setServerReferenced(server, false);
    }
  }
}

async function _awaitWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns a runRgWindowedLines-shaped result, or null when the native server
 *  is unavailable or the request shape is unsupported. */
// Boot-time prewarm: binary resolution is async (dynamic import), so the
// first search of a cold session otherwise waits for startup. Long-lived hosts
// call this fire-and-forget to have the resident
// server up before the first tool call. Honors the same kill switch.
export async function warmNativeSearchServer(timeoutMs = 5_000) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return false;
  if (!_warmPromise) {
    const warm = (async () => {
      try {
        if (!_resolveBinary()) {
          const mod = await import('../code-graph/graph-binary.mjs');
          let candidate = mod.graphBinaryPath?.() || mod.resolveGraphBinaryPath?.() || null;
          if (!candidate) candidate = await ensureGraphBinary(getPluginData());
          if (candidate && existsSync(candidate)) _binaryPath = candidate;
          else if (_binaryPath === undefined) _binaryPath = null;
        }
        const server = _ensureServer();
        return await _waitServerReady(server);
      } catch {
        return false;
      }
    })();
    _warmPromise = warm;
    void warm.finally(() => {
      if (_warmPromise === warm) _warmPromise = null;
    });
  }
  return await _awaitWithin(_warmPromise, timeoutMs);
}

async function _readyServer(timeoutMs = SERVER_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  let server = _ensureServer();
  if (server && await _waitServerReady(server, remaining())) return server;
  if (await warmNativeSearchServer(remaining())) {
    server = _ensureServer();
    if (server && await _waitServerReady(server, remaining())) return server;
  }
  return null;
}

/** Fast Windows process table snapshot served by the resident native helper.
 *  Returns [{pid,parentPid,identity}] or null; callers stay conservative when
 *  the binary is unavailable or the request misses its short deadline. */
export async function tryNativeProcessSnapshot({ timeoutMs = 750 } = {}) {
  if (process.platform !== 'win32' || process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const server = await _readyServer(Math.max(1, Number(timeoutMs) || 750));
  if (!server) return null;
  const id = ++server.sequence;
  _setServerReferenced(server, true);
  const response = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      if (server.pending.size === 0) _setServerReferenced(server, false);
    };
    const timer = setTimeout(() => {
      server.pending.delete(id);
      settle(null);
    }, Math.max(1, Number(timeoutMs) || 750));
    timer.unref?.();
    server.pending.set(id, { resolve: settle, reject: () => settle(null) });
    try {
      server.child.stdin.write(`${JSON.stringify({ id, processSnapshot: true })}\n`);
    } catch {
      server.pending.delete(id);
      settle(null);
    }
  });
  if (!response || response.error || !Array.isArray(response.rows)) return null;
  return response.rows;
}

async function requestNative(server, request, execOptions, deadlineMs) {
  _setServerReferenced(server, true);
  const response = await new Promise((resolve) => {
    let settled = false;
    let onAbort = null;
    const cancelServerWork = () => {
      try { server.child.stdin.write(`${JSON.stringify({ cancel: request.id })}\n`); } catch {}
    };
    const settle = (value, cancel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) {
        try { execOptions.signal?.removeEventListener?.('abort', onAbort); } catch {}
        onAbort = null;
      }
      if (cancel) cancelServerWork();
      resolve(value);
      if (server.pending.size === 0) _setServerReferenced(server, false);
    };
    const timer = setTimeout(() => {
      server.pending.delete(request.id);
      server.timeoutStreak += 1;
      settle(null, true);
      if (server.timeoutStreak >= 2 && _server === server) {
        _teardown(new Error('native search server timed out repeatedly'));
      }
    }, deadlineMs);
    timer.unref?.();
    server.pending.set(request.id, { resolve: settle, reject: () => settle(null) });
    onAbort = () => {
      server.pending.delete(request.id);
      settle(null, true);
    };
    if (execOptions.signal?.aborted) {
      onAbort();
      return;
    }
    execOptions.signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      server.child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch {
      server.pending.delete(request.id);
      settle(null);
    }
  });
  return response;
}

export async function tryServeSearch(argsList, execOptions = {}, opts = {}) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const callerTimeoutMs = Number(execOptions.timeout);
  const deadlineMs = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
    ? Math.min(callerTimeoutMs, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
  const readyStartedAt = Date.now();
  const server = await _readyServer(Math.min(deadlineMs, SERVER_READY_TIMEOUT_MS));
  if (!server) return null;
  const requestDeadlineMs = Math.max(1, deadlineMs - (Date.now() - readyStartedAt));
  const response = await requestNative(server, {
    id: ++server.sequence,
    cwd: String(execOptions.cwd || process.cwd()),
    args: argsList.map(String),
    offset: Math.max(0, Math.floor(Number(opts.offset) || 0)),
    limit: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
      ? Math.floor(Number(opts.limit))
      : 0,
  }, execOptions, requestDeadlineMs);
  if (!response) return null;
  if (response.unsupported || response.error) {
    const rejected = new Error(String(response.error || response.unsupported));
    rejected.code = response.error ? 'NATIVE_SEARCH_ERROR' : 'NATIVE_SEARCH_UNSUPPORTED';
    throw rejected;
  }
  if (!Array.isArray(response.lines)) return null;
  return {
    lines: response.lines,
    complete: response.complete === true,
    totalSeen: Math.max(0, Math.floor(Number(response.totalSeen) || 0)),
    queueMs: Math.max(0, Number(response.queueMs) || 0),
    handlerMs: Math.max(0, Number(response.handlerMs) || 0),
    requestClass: response.class === 'bulk' ? 'bulk' : 'interactive',
    served: true,
  };
}

export async function tryServeFuzzySearch(args, execOptions = {}) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const callerTimeoutMs = Number(execOptions.timeout);
  const deadlineMs = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
    ? Math.min(callerTimeoutMs, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
  const readyStartedAt = Date.now();
  const server = await _readyServer(Math.min(deadlineMs, SERVER_READY_TIMEOUT_MS));
  if (!server) return null;
  const requestDeadlineMs = Math.max(1, deadlineMs - (Date.now() - readyStartedAt));
  const response = await requestNative(server, {
    id: ++server.sequence,
    cwd: String(args?.cwd || execOptions.cwd || process.cwd()),
    fuzzy: String(args?.query || ''),
    limit: Math.max(1, Math.min(1_000, Math.floor(Number(args?.limit) || 25))),
    hidden: args?.hidden !== false,
    includeNoise: args?.includeNoise === true,
    ...(Number.isFinite(Number(args?.maxDepth)) && Number(args.maxDepth) > 0
      ? { maxDepth: Math.floor(Number(args.maxDepth)) }
      : {}),
    exclude: Array.isArray(args?.exclude) ? args.exclude.map(String) : [],
  }, execOptions, requestDeadlineMs);
  if (!response || response.unsupported || response.error || !Array.isArray(response.matches)) return null;
  return {
    matches: response.matches.map(String),
    hasMore: response.hasMore === true,
    totalMatches: Math.max(0, Number(response.totalMatches) || 0),
    totalSeen: Math.max(0, Number(response.totalSeen) || 0),
    complete: response.complete === true,
    queueMs: Math.max(0, Number(response.queueMs) || 0),
    handlerMs: Math.max(0, Number(response.handlerMs) || 0),
    requestClass: response.class === 'fuzzy' ? 'fuzzy' : 'bulk',
    served: true,
  };
}

export function _resetNativeSearchClientForTest() {
  _teardown(new Error('test reset'));
  _binaryPath = undefined;
  _lastFailureAt = 0;
  _binaryResolveStarted = false;
  _warmPromise = null;
}
