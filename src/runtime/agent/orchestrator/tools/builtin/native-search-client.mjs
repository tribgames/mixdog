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
import { reportShardUnhealthy } from '../../../../shared/session-shard-health.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { getPluginData } from '../../config.mjs';
import { ensureGraphBinary } from '../graph-binary-fetcher.mjs';
import { fuzzyRank, prepareFuzzyItems } from './fuzzy-match.mjs';

const RESTART_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_READY_TIMEOUT_MS = 1_000;
const CANCEL_GRACE_MS = 1_000;
const PROCESS_FAILURES_BEFORE_BACKOFF = 2;
const SEARCH_TIMEOUT_RECYCLE_WINDOW_MS = 30_000;
const SEARCH_TIMEOUT_BURST_MS = 1_000;

let _server = null; // { child, pending: Map, sequence }
let _binaryPath = undefined; // undefined = unresolved, null = unavailable
let _lastFailureAt = 0;
let _lastFailure = null;
let _consecutiveProcessFailures = 0;
let _binaryResolveStarted = false;
let _warmPromise = null;
let _lastTimeoutRecycleAt = 0;
let _lastTimedOutServer = null;
const _abortSignalSubscribers = new WeakMap();

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requestKind(request) {
  if (request?.processSnapshot) return 'process snapshot';
  if (request?.fuzzy != null) return 'fuzzy';
  return request?.args?.includes?.('--files') ? 'file inventory' : 'content';
}

function timeoutError(request, deadlineMs) {
  const kind = requestKind(request);
  const detail = kind === 'fuzzy'
    ? ' Fuzzy ranking requires a complete file inventory; narrow cwd or set max depth.'
    : '';
  return codedError(
    'NATIVE_SEARCH_TIMEOUT',
    `native ${kind} search timed out after ${deadlineMs}ms.${detail}`,
  );
}

function softDeadlineMs(hardDeadlineMs) {
  // Leave enough of the caller's total budget for response serialization,
  // transport, and JS-side ranking. The old 500ms ceiling raced the outer
  // 20s read-only deadline and discarded a valid native partial response.
  const margin = Math.min(2_000, Math.max(250, Math.floor(hardDeadlineMs * 0.075)));
  return Math.max(1, hardDeadlineMs - margin);
}

function processFailure(error, server, detail = '') {
  if (error?.code === 'NATIVE_SEARCH_PROCESS_EXIT') return error;
  const stderr = String(server?.stderrTail || '').trim();
  const cause = error instanceof Error
    ? `${error.code ? `${error.code}: ` : ''}${error.message}`
    : '';
  const suffix = [detail, cause, stderr ? `stderr: ${stderr}` : ''].filter(Boolean).join('; ');
  return codedError(
    'NATIVE_SEARCH_PROCESS_EXIT',
    `native search server exited${suffix ? ` (${suffix})` : ''}`,
    error instanceof Error ? error : null,
  );
}

function noteProcessFailure(error) {
  _lastFailure = error;
  _consecutiveProcessFailures += 1;
  if (_consecutiveProcessFailures >= PROCESS_FAILURES_BEFORE_BACKOFF) {
    _lastFailureAt = Date.now();
  }
}

function clearProcessFailures() {
  _lastFailure = null;
  _lastFailureAt = 0;
  _consecutiveProcessFailures = 0;
}

function noteSearchTimeout(server, now = Date.now()) {
  const sincePrevious = _lastTimeoutRecycleAt > 0 ? now - _lastTimeoutRecycleAt : Infinity;
  _lastTimedOutServer = server || null;
  _lastTimeoutRecycleAt = now;
  // Requests issued as one batch time out together; that burst is a single
  // event, not a streak.
  if (sincePrevious <= SEARCH_TIMEOUT_BURST_MS) return 'none';
  // The server is no longer recycled on a first timeout, so a recurrence
  // within the window — on this server or its replacement — is what marks the
  // shard unhealthy.
  return sincePrevious <= SEARCH_TIMEOUT_RECYCLE_WINDOW_MS ? 'shard' : 'server';
}

function subscribeAbortSignal(signal, callback) {
  if (!signal?.addEventListener || typeof callback !== 'function') return () => {};
  let state = _abortSignalSubscribers.get(signal);
  if (!state) {
    const callbacks = new Set();
    const listener = () => {
      _abortSignalSubscribers.delete(signal);
      const pending = [...callbacks];
      callbacks.clear();
      for (const fn of pending) {
        try { fn(); } catch {}
      }
    };
    state = { callbacks, listener };
    _abortSignalSubscribers.set(signal, state);
    signal.addEventListener('abort', listener, { once: true });
  }
  state.callbacks.add(callback);
  return () => {
    if (!state.callbacks.delete(callback) || state.callbacks.size > 0) return;
    if (_abortSignalSubscribers.get(signal) === state) {
      _abortSignalSubscribers.delete(signal);
      try { signal.removeEventListener('abort', state.listener); } catch {}
    }
  };
}

function unavailableError() {
  const detail = _lastFailure?.message ? ` Last process failure: ${_lastFailure.message}` : '';
  return codedError('NATIVE_SEARCH_UNAVAILABLE', `native search server unavailable.${detail}`);
}

function _setServerReferenced(server, referenced) {
  const method = referenced ? 'ref' : 'unref';
  try { server?.child?.[method]?.(); } catch {}
  try { server?.child?.stdin?.[method]?.(); } catch {}
  try { server?.child?.stdout?.[method]?.(); } catch {}
  try { server?.child?.stderr?.[method]?.(); } catch {}
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

function _teardown(error, { countFailure = true, detail = '' } = {}) {
  const server = _server;
  _server = null;
  if (!server) return;
  const failure = processFailure(error, server, detail);
  if (countFailure) noteProcessFailure(failure);
  for (const pending of server.pending.values()) {
    try { pending.reject(failure); } catch {}
  }
  server.pending.clear();
  for (const timer of server.cancelWatchdogs?.values?.() || []) clearTimeout(timer);
  server.cancelWatchdogs?.clear?.();
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
  if (
    _consecutiveProcessFailures >= PROCESS_FAILURES_BEFORE_BACKOFF
    && Date.now() - _lastFailureAt < RESTART_BACKOFF_MS
  ) return null;
  const binary = _resolveBinary();
  if (!binary) return null;
  let child;
  try {
    child = spawn(binary, [process.cwd(), '--serve-search'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...hiddenSpawnOpts,
    });
  } catch (error) {
    noteProcessFailure(processFailure(error, null, 'spawn failed'));
    return null;
  }
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const server = {
    child,
    pending: new Map(),
    cancelWatchdogs: new Map(),
    sequence: 0,
    stderrTail: '',
    ready,
    readyState: false,
    readyWaiters: 0,
    resolveReady,
  };
  child.stderr?.on?.('data', (chunk) => {
    server.stderrTail = `${server.stderrTail}${String(chunk || '')}`.slice(-8192);
  });
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
    if (message?.event === 'cancelled') {
      completeNativeCancellation(server, Number(message?.id));
      clearProcessFailures();
      return;
    }
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    server.pending.delete(Number(message.id));
    clearProcessFailures();
    pending.resolve(message);
  });
  _bindNativeSearchServerLifecycle(child, {
    onError: (error) => { if (_server === server) _teardown(error); },
    onExit: (code, signal) => {
      if (_server === server) {
        _teardown(null, {
          countFailure: true,
          detail: `exit code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        });
      }
    },
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

function cancelGraceMs() {
  const configured = Number(process.env.MIXDOG_SEARCH_CANCEL_GRACE_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : CANCEL_GRACE_MS;
}

function completeNativeCancellation(server, id) {
  const timer = server?.cancelWatchdogs?.get?.(id);
  if (timer) clearTimeout(timer);
  server?.cancelWatchdogs?.delete?.(id);
}

function armNativeCancellationWatchdog(server, request) {
  if (!(server.cancelWatchdogs instanceof Map)) server.cancelWatchdogs = new Map();
  completeNativeCancellation(server, request.id);
  const graceMs = cancelGraceMs();
  const timer = setTimeout(() => {
    server.cancelWatchdogs.delete(request.id);
    const error = codedError(
      'NATIVE_SEARCH_CANCEL_STALLED',
      `native ${requestKind(request)} search did not stop within ${graceMs}ms after cancellation`,
    );
    if (_server === server) {
      _teardown(error, { countFailure: false, detail: 'cancellation grace expired' });
    } else {
      try { server.child.kill(); } catch {}
    }
  }, graceMs);
  timer.unref?.();
  server.cancelWatchdogs.set(request.id, timer);
}

export { completeNativeCancellation as _ackNativeSearchCancellationForTest };

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
  const deadlineMs = Math.max(1, Number(timeoutMs) || 750);
  let response;
  try {
    response = await requestNativeWithRestart(
      (server) => ({ id: ++server.sequence, processSnapshot: true }),
      {},
      deadlineMs,
    );
  } catch {
    return null;
  }
  if (!response || response.error || !Array.isArray(response.rows)) return null;
  return response.rows;
}

async function requestNative(server, request, execOptions, deadlineMs) {
  _setServerReferenced(server, true);
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    let onAbort = null;
    let unsubscribeAbort = null;
    const cancelServerWork = () => {
      try { server.child.stdin.write(`${JSON.stringify({ cancel: request.id })}\n`); } catch {}
      armNativeCancellationWatchdog(server, request);
    };
    const settle = (value, cancel = false, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsubscribeAbort?.(); } catch {}
      unsubscribeAbort = null;
      onAbort = null;
      if (cancel) cancelServerWork();
      if (error) reject(error);
      else resolve(value);
      if (server.pending.size === 0) _setServerReferenced(server, false);
    };
    const settleTimeout = (error) => {
      const action = requestKind(request) === 'process snapshot'
        ? 'none'
        : noteSearchTimeout(server);
      settle(null, true, error);
      if (action === 'none') return;
      // A single timeout no longer recycles the server: `settle(cancel=true)`
      // already told it to stop, and the cancellation watchdog tears it down
      // if it does not comply. Killing it here also destroyed every warm
      // inventory, so the next call re-walked from cold and timed out again.
      if (action !== 'shard') return;
      reportShardUnhealthy({
        reason: 'native search timed out again after server recycle',
        code: 'NATIVE_SEARCH_TIMEOUT_STREAK',
        subsystem: 'native-search',
      });
      queueMicrotask(() => {
        if (_server === server) {
          _teardown(error, { countFailure: false, detail: 'repeated request timeouts' });
        }
      });
    };
    const timer = setTimeout(() => {
      server.pending.delete(request.id);
      settleTimeout(timeoutError(request, deadlineMs));
    }, deadlineMs);
    timer.unref?.();
    server.pending.set(request.id, {
      resolve: settle,
      reject: (error) => settle(null, false, processFailure(error, server)),
    });
    onAbort = () => {
      server.pending.delete(request.id);
      const reason = execOptions.signal?.reason;
      if (reason?.code === 'READ_ONLY_IO_TIMEOUT') {
        settleTimeout(timeoutError(request, deadlineMs));
      } else {
        settle(
          null,
          true,
          codedError('NATIVE_SEARCH_ABORTED', `native ${requestKind(request)} search aborted`),
        );
      }
    };
    if (execOptions.signal?.aborted) {
      onAbort();
      return;
    }
    unsubscribeAbort = subscribeAbortSignal(execOptions.signal, onAbort);
    try {
      server.child.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (error) {
      if (_server === server) _teardown(error);
      else {
        server.pending.delete(request.id);
        settle(null, false, processFailure(error, server, 'stdin write failed'));
      }
    }
  });
  return response;
}

export {
  noteSearchTimeout as _noteSearchTimeoutForTest,
  requestNative as _requestNativeForTest,
  softDeadlineMs as _softDeadlineMsForTest,
};

async function requestNativeWithRestart(buildRequest, execOptions, deadlineMs) {
  const startedAt = Date.now();
  let server = await _readyServer(Math.min(deadlineMs, SERVER_READY_TIMEOUT_MS));
  if (!server) throw unavailableError();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = Math.max(1, deadlineMs - (Date.now() - startedAt));
    try {
      return await requestNative(server, buildRequest(server, remaining), execOptions, remaining);
    } catch (error) {
      if (error?.code !== 'NATIVE_SEARCH_PROCESS_EXIT' || attempt > 0) throw error;
      server = await _readyServer(Math.min(remaining, SERVER_READY_TIMEOUT_MS));
      if (!server) throw unavailableError();
    }
  }
  throw unavailableError();
}

export async function tryServeSearch(argsList, execOptions = {}, opts = {}) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const callerTimeoutMs = Number(execOptions.timeout);
  const deadlineMs = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
    ? Math.min(callerTimeoutMs, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
  const buildRequest = (server, remaining) => ({
    id: ++server.sequence,
    cwd: String(execOptions.cwd || process.cwd()),
    args: argsList.map(String),
    offset: Math.max(0, Math.floor(Number(opts.offset) || 0)),
    limit: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
      ? Math.floor(Number(opts.limit))
      : 0,
    deadlineMs: softDeadlineMs(remaining),
    keepWarm: opts.keepWarm === true,
  });
  let response = await requestNativeWithRestart(buildRequest, execOptions, deadlineMs);
  // Deadline-swallow defense (binaries before the serve_search response-level
  // deadline re-check): a server under host saturation can burn the whole
  // soft deadline queued+scanning and return complete-but-EMPTY with the
  // mid-scan timeout swallowed — indistinguishable from a real no-match and
  // observed as a false "(no matches)". When an empty "complete" answer's
  // queue+handler time consumed its deadline budget, re-ask ONCE; the retry
  // (served from a now-warm server) returns either the real matches or a
  // fast, trustworthy empty.
  const legacySuspectEmpty = (
    Array.isArray(response.lines) && response.lines.length === 0
    && response.complete === true && response.partial !== true
    && response.inventoryChecked !== true
    && (
      (Number(response.queueMs) || 0) + (Number(response.handlerMs) || 0)
        >= Math.max(500, softDeadlineMs(deadlineMs) - 250)
      // filesScanned===0 on an empty "complete" answer: the scan loops never
      // opened a single file. Either the scope truly has no eligible files
      // (retry returns the same answer in ~ms) or the server's file list was
      // transiently wrong (observed once: a file-scope grep answered empty in
      // 0ms while the file demonstrably matched). One re-ask disambiguates.
      || Number(response.filesScanned) === 0
    )
  );
  if (legacySuspectEmpty) {
    if (_server) {
      _teardown(
        codedError('NATIVE_SEARCH_INTEGRITY', 'native search returned an unverified empty result'),
        { countFailure: false, detail: 'unverified empty response' },
      );
    }
    try {
      response = await requestNativeWithRestart(buildRequest, execOptions, deadlineMs);
    } catch (error) {
      throw codedError(
        'NATIVE_SEARCH_INTEGRITY',
        'native search could not verify an empty result with a fresh server',
        error,
      );
    }
    const retryConsumedDeadline = Array.isArray(response.lines)
      && response.lines.length === 0
      && response.complete === true
      && response.partial !== true
      && response.inventoryChecked !== true
      && (Number(response.queueMs) || 0) + (Number(response.handlerMs) || 0)
        >= Math.max(500, softDeadlineMs(deadlineMs) - 250);
    if (retryConsumedDeadline) {
      throw codedError(
        'NATIVE_SEARCH_INTEGRITY',
        'native search returned an unverified empty result after a fresh-server retry',
      );
    }
  }
  if (response.unsupported || response.error) {
    const rejected = new Error(String(response.error || response.unsupported));
    rejected.code = response.error ? 'NATIVE_SEARCH_ERROR' : 'NATIVE_SEARCH_UNSUPPORTED';
    throw rejected;
  }
  if (!Array.isArray(response.lines)) return null;
  const scanErrors = Math.max(0, Math.floor(Number(response.scanErrors) || 0));
  const walkErrorDetails = Array.isArray(response.walkErrorDetails)
    ? response.walkErrorDetails.map(String).slice(0, 8)
    : [];
  return {
    lines: response.lines,
    complete: response.complete === true,
    totalSeen: Math.max(0, Math.floor(Number(response.totalSeen) || 0)),
    partial: response.partial === true,
    timeout: response.timeout === true,
    // Unreadable/half-read files the native scanner skipped: route the count
    // through the existing rg-exit-2 partial phrasing in search-tool.mjs so
    // the model sees WHY the result may be missing matches.
    ...(scanErrors > 0
      ? {
          rgStderr: `${scanErrors} file(s) could not be read (permission or I/O error); matches from those files are missing`
            + (walkErrorDetails.length > 0 ? `; ${walkErrorDetails.join('; ')}` : ''),
        }
      : {}),
    queueMs: Math.max(0, Number(response.queueMs) || 0),
    handlerMs: Math.max(0, Number(response.handlerMs) || 0),
    requestClass: response.class === 'bulk' ? 'bulk' : 'interactive',
    inventoryChecked: response.inventoryChecked === true,
    cacheSafe: response.cacheSafe !== false,
    walkErrorDetails,
    served: true,
  };
}

export async function tryServeFuzzySearch(args, execOptions = {}) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const callerTimeoutMs = Number(execOptions.timeout);
  const deadlineMs = Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
    ? Math.min(callerTimeoutMs, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
  const response = await requestNativeWithRestart(
    (server, remaining) => ({
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
      deadlineMs: softDeadlineMs(remaining),
    }),
    execOptions,
    deadlineMs,
  );
  if (response?.unsupported) {
    throw codedError('NATIVE_SEARCH_UNSUPPORTED', String(response.unsupported));
  }
  if (response?.error) {
    throw codedError('NATIVE_SEARCH_ERROR', String(response.error));
  }
  if (!Array.isArray(response?.matches)) throw unavailableError();
  // Parity with the JS scorer's noise floor: the native matcher scores any
  // subsequence, so a query with no real hit returns scattered junk paths
  // (hash-named artifacts and the like). Re-rank the returned window through
  // fuzzyRank, which keeps contiguous/basename hits unconditionally and
  // drops sub-floor subsequence-only matches instead of surfacing noise.
  const query = String(args?.query || '');
  const filtered = query
    ? fuzzyRank(query, prepareFuzzyItems(response.matches.map(String)))
      .map((entry) => entry.item.path)
    : response.matches.map(String);
  return {
    matches: filtered,
    hasMore: response.hasMore === true,
    totalMatches: Math.max(0, Number(response.totalMatches) || 0),
    totalSeen: Math.max(0, Number(response.totalSeen) || 0),
    complete: response.complete === true,
    partial: response.partial === true,
    timeout: response.timeout === true,
    scanErrors: Math.max(0, Math.floor(Number(response.scanErrors) || 0)),
    walkErrorDetails: Array.isArray(response.walkErrorDetails)
      ? response.walkErrorDetails.map(String).slice(0, 8)
      : [],
    inventoryChecked: response.inventoryChecked === true,
    cacheSafe: response.cacheSafe !== false,
    queueMs: Math.max(0, Number(response.queueMs) || 0),
    handlerMs: Math.max(0, Number(response.handlerMs) || 0),
    requestClass: response.class === 'fuzzy' ? 'fuzzy' : 'bulk',
    served: true,
  };
}

export function _resetNativeSearchClientForTest() {
  _teardown(new Error('test reset'), { countFailure: false });
  _binaryPath = undefined;
  _lastFailureAt = 0;
  _lastFailure = null;
  _consecutiveProcessFailures = 0;
  _binaryResolveStarted = false;
  _warmPromise = null;
  _lastTimeoutRecycleAt = 0;
  _lastTimedOutServer = null;
}
