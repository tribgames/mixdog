// Resident native search: forwards rg-style windowed line requests to ONE
// long-lived `mixdog-graph --serve-search` process instead of spawning rg per
// call. Per-call spawn + AV on-access scan measured ~100ms fixed on win32
// while the actual match work is ~5-10ms; a warm in-process scan answers in
// single-digit ms. The server accepts only the arg subset the grep builder
// emits — anything else answers `unsupported` and the caller falls back to
// the real rg spawn, so behavior can never be lost, only accelerated.
// MIXDOG_SEARCH_SERVER=0 disables; MIXDOG_SEARCH_SERVER_BIN overrides the
// binary (dev builds).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';

const RESTART_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

let _server = null; // { child, pending: Map, sequence }
let _binaryPath = undefined; // undefined = unresolved, null = unavailable
let _lastFailureAt = 0;

function _setServerReferenced(server, referenced) {
  const method = referenced ? 'ref' : 'unref';
  try { server?.child?.[method]?.(); } catch {}
  try { server?.child?.stdin?.[method]?.(); } catch {}
  try { server?.child?.stdout?.[method]?.(); } catch {}
}

function _resolveBinary() {
  if (_binaryPath !== undefined) return _binaryPath;
  const explicit = String(process.env.MIXDOG_SEARCH_SERVER_BIN || '').trim();
  if (explicit && existsSync(explicit)) {
    _binaryPath = explicit;
    return _binaryPath;
  }
  _binaryPath = null;
  // Reuse the code-graph binary resolution lazily; resolver shape is duck-
  // typed so a refactor there degrades to "server unavailable", never throws.
  void import('../code-graph/graph-binary.mjs').then((mod) => {
    try {
      const candidate = mod.graphBinaryPath?.() || mod.resolveGraphBinaryPath?.() || null;
      if (candidate && existsSync(candidate)) _binaryPath = candidate;
    } catch { /* stay unavailable */ }
  }).catch(() => {});
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
  try { server.child.kill(); } catch {}
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
  const server = { child, pending: new Map(), sequence: 0 };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    server.pending.delete(Number(message.id));
    pending.resolve(message);
  });
  child.on('error', (error) => { if (_server === server) _teardown(error); });
  child.on('exit', () => { if (_server === server) _teardown(); });
  // A detached child can still pin a one-shot CLI/test through its pipe
  // handles. Keep the resident server idle-unreferenced, then ref all handles
  // only while a request is awaiting a response.
  _setServerReferenced(server, false);
  _server = server;
  return server;
}

/** rg-runner seam: returns a runRgWindowedLines-shaped result, or null when
 *  the server is unavailable / the request shape is unsupported (caller then
 *  spawns rg exactly as before). */
// Boot-time prewarm: binary resolution is async (dynamic import), so the
// first search of a cold session otherwise races it and falls back to a
// spawn. Long-lived hosts call this fire-and-forget to have the resident
// server up before the first tool call. Honors the same kill switch.
export async function warmNativeSearchServer() {
  try {
    if (process.env.MIXDOG_SEARCH_SERVER === '0') return false;
    if (_resolveBinary() === null) {
      const mod = await import('../code-graph/graph-binary.mjs');
      const candidate = mod.graphBinaryPath?.() || mod.resolveGraphBinaryPath?.() || null;
      if (candidate && existsSync(candidate)) _binaryPath = candidate;
    }
    return Boolean(_ensureServer());
  } catch {
    return false;
  }
}

/** Fast Windows process table snapshot served by the resident native helper.
 *  Returns [{pid,parentPid,identity}] or null; callers stay conservative when
 *  the binary is unavailable or the request misses its short deadline. */
export async function tryNativeProcessSnapshot({ timeoutMs = 750 } = {}) {
  if (process.platform !== 'win32' || process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  let server = _ensureServer();
  if (!server && await warmNativeSearchServer()) server = _ensureServer();
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

export async function tryServeSearch(argsList, execOptions = {}, opts = {}) {
  if (process.env.MIXDOG_SEARCH_SERVER === '0') return null;
  const server = _ensureServer();
  if (!server) return null;
  const id = ++server.sequence;
  _setServerReferenced(server, true);
  const request = {
    id,
    cwd: String(execOptions.cwd || process.cwd()),
    args: argsList.map(String),
    offset: Math.max(0, Math.floor(Number(opts.offset) || 0)),
    limit: Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
      ? Math.floor(Number(opts.limit))
      : 0,
  };
  const response = await new Promise((resolve) => {
    let settled = false;
    let onAbort = null;
    const cancelServerWork = () => {
      try { server.child.stdin.write(`${JSON.stringify({ cancel: id })}\n`); } catch {}
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
      server.pending.delete(id);
      settle(null, true);
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    server.pending.set(id, { resolve: settle, reject: () => settle(null) });
    onAbort = () => {
      server.pending.delete(id);
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
      server.pending.delete(id);
      settle(null);
    }
  });
  if (!response || response.unsupported || response.error) return null;
  if (!Array.isArray(response.lines)) return null;
  return {
    lines: response.lines,
    complete: response.complete === true,
    totalSeen: Math.max(0, Math.floor(Number(response.totalSeen) || 0)),
    served: true,
  };
}

export function _resetNativeSearchClientForTest() {
  _teardown(new Error('test reset'));
  _binaryPath = undefined;
  _lastFailureAt = 0;
}
