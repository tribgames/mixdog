// Transports for the resident native search engine.
//
// The engine is one Rust implementation reachable two ways, and this module is
// the only place that knows which one is in use:
//
//   - addon: `mixdog-graph.node` loaded INTO this process. No child process,
//     therefore no separate Windows Task Manager row (Task Manager groups rows
//     per executable image, so a separately named helper can never fold into
//     the app's row regardless of its version resource).
//   - child: `mixdog-graph --serve-search` over stdin/stdout pipes. The
//     fallback whenever the addon is absent or refuses to load, and the only
//     path that survives a crash in the engine without taking the host down.
//
// Both speak the identical JSONL protocol, so the client above them writes
// request lines and reads response lines without caring which is attached.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import { packageNativeToolsDir } from '../../../../shared/native-tool-paths.mjs';

// Deliberately NOT a NATIVE_TOOL_FILENAMES entry: that map is the contract for
// the released asset set, and every key in it is an asset the installer must
// fetch. The addon is an optional accelerator — its absence falls back to the
// executable — so it resolves by name from the same directory instead.
const ADDON_FILE_NAME = 'mixdog-graph.node';
const PLUGIN_ROOT = process.env.MIXDOG_ROOT
  || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../../../..');
const LOCAL_ADDON = pathJoin(
  PLUGIN_ROOT,
  'native/mixdog-graph-addon/target/release',
  ADDON_FILE_NAME,
);

function disabled(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? '').trim());
}

let _addonPath; // undefined = unresolved, null = unavailable

/** Absolute path to the in-process addon, or null when this install has none. */
export function resolveNativeSearchAddon() {
  if (_addonPath !== undefined) return _addonPath;
  if (disabled(process.env.MIXDOG_SEARCH_SERVER_ADDON)) {
    _addonPath = null;
    return _addonPath;
  }
  const explicit = String(process.env.MIXDOG_SEARCH_SERVER_ADDON || '').trim();
  const candidates = [
    explicit && !disabled(explicit) ? explicit : null,
    LOCAL_ADDON,
    pathJoin(packageNativeToolsDir(), ADDON_FILE_NAME),
  ].filter(Boolean);
  _addonPath = candidates.find((candidate) => {
    try { return existsSync(candidate); } catch { return false; }
  }) || null;
  return _addonPath;
}

export function _resetNativeSearchAddonPathForTest() {
  _addonPath = undefined;
}

/** Minimal event fan-out: one transport feeds exactly one client. */
function createEmitter() {
  const handlers = { line: null, stderr: null, error: null, exit: null };
  return {
    handlers,
    emit(name, ...args) {
      const handler = handlers[name];
      if (typeof handler !== 'function') return;
      try { handler(...args); } catch { /* a listener fault must not kill the transport */ }
    },
  };
}

function createAddonTransport(addonPath) {
  const require = createRequire(import.meta.url);
  const addon = require(addonPath);
  if (typeof addon?.SearchServer !== 'function') {
    throw new TypeError('mixdog-graph addon does not export SearchServer');
  }
  const { handlers, emit } = createEmitter();
  const server = new addon.SearchServer((line) => { emit('line', String(line)); });
  let closed = false;
  // The addon's callback is intentionally weak: it must never be the reason
  // this process stays alive. So an explicit handle carries the reference
  // instead, held only while the client has work outstanding — the same
  // lifetime the child transport's pipe handles used to provide.
  let keepAlive = null;
  const close = (code) => {
    if (closed) return;
    closed = true;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    try { server.shutdown(); } catch { /* already down */ }
    emit('exit', code, null);
  };
  return {
    kind: 'addon',
    // Nothing to surface: the engine reports faults as protocol responses
    // rather than as a side channel.
    stderr: null,
    write(text) {
      if (closed) throw new Error('native search addon is closed');
      for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        if (!server.send(line)) throw new Error('native search engine rejected a request');
      }
    },
    end() { close(0); },
    kill() { close(0); },
    ref() {
      if (closed || keepAlive) return;
      keepAlive = setInterval(() => {}, 60_000);
    },
    unref() {
      if (!keepAlive) return;
      clearInterval(keepAlive);
      keepAlive = null;
    },
    on(name, handler) { handlers[name] = handler; },
  };
}

function createChildTransport(binaryPath, cwd) {
  const child = spawn(binaryPath, [cwd, '--serve-search'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...hiddenSpawnOpts,
  });
  const { handlers, emit } = createEmitter();
  child.stderr?.on?.('data', (chunk) => emit('stderr', chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => emit('line', line));
  bindChildLifecycle(child, {
    onError: (error) => emit('error', error),
    onExit: (code, signal) => emit('exit', code, signal),
  });
  return {
    kind: 'child',
    child,
    write(text) { child.stdin.write(text); },
    end() { try { child.stdin?.end?.(); } catch { /* already closed */ } },
    kill(signal) { try { child.kill(signal); } catch { /* already gone */ } },
    ref() {
      for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
        try { handle?.ref?.(); } catch { /* detached handle */ }
      }
    },
    unref() {
      for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
        try { handle?.unref?.(); } catch { /* detached handle */ }
      }
    },
    on(name, handler) { handlers[name] = handler; },
  };
}

/**
 * ChildProcess stdin emits write failures asynchronously. A sync try/catch
 * around stdin.write cannot catch EPIPE; without this listener the session
 * runtime worker itself terminates and every active/queued turn is recovered.
 */
export function bindChildLifecycle(child, { onError, onExit } = {}) {
  if (!child?.on) return;
  child.on('error', onError);
  child.on('exit', onExit);
  child.stdin?.on?.('error', onError);
}

/**
 * Attach to the engine, preferring the in-process addon. Returns null when
 * neither transport is available; throws only on an unexpected spawn failure,
 * which the caller counts as a process failure.
 */
export function createNativeSearchTransport({ binaryPath, cwd }) {
  const addonPath = resolveNativeSearchAddon();
  if (addonPath) {
    try {
      return createAddonTransport(addonPath);
    } catch {
      // A stale or ABI-mismatched addon must not disable search: fall through
      // to the child process and remember not to retry the load per request.
      _addonPath = null;
    }
  }
  if (!binaryPath) return null;
  return createChildTransport(binaryPath, cwd);
}
