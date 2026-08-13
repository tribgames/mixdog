import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';

const RESTART_BACKOFF_MS = 30_000;

let _server = null;
let _binaryPath = undefined;
let _lastFailureAt = 0;

class LineStream extends EventEmitter {
  constructor() {
    super();
    this._pending = '';
  }
  setEncoding() { return this; }
  emit(event, ...args) {
    if (event === 'data' && this.listenerCount('data') === 0) {
      this._pending += args[0] == null ? '' : String(args[0]);
      return false;
    }
    return super.emit(event, ...args);
  }
  on(event, listener) {
    const ret = super.on(event, listener);
    if (event === 'data' && this._pending) {
      const pending = this._pending;
      this._pending = '';
      queueMicrotask(() => listener(pending));
    }
    return ret;
  }
}

export class NativeSpawnChild extends EventEmitter {
  constructor(id, cancel) {
    super();
    this.pid = undefined;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new LineStream();
    this.stderr = new LineStream();
    this.stdin = null;
    this.__nativeSpawn = true;
    this._id = id;
    this._cancel = cancel;
    this._closed = false;
  }

  kill() {
    this.killed = true;
    this._cancel?.(this._id);
    return true;
  }

  on(event, listener) {
    const ret = super.on(event, listener);
    if (event === 'close' && this._closed) {
      queueMicrotask(() => listener(this.exitCode, this.signalCode));
    }
    return ret;
  }

  once(event, listener) {
    if (event === 'close' && this._closed) {
      queueMicrotask(() => listener(this.exitCode, this.signalCode));
      return this;
    }
    return super.once(event, listener);
  }
}

function _resolveBinary() {
  if (_binaryPath !== undefined) return _binaryPath;
  const explicit = String(process.env.MIXDOG_SPAWN_SERVER_BIN || '').trim();
  if (explicit && existsSync(explicit)) {
    _binaryPath = explicit;
    return _binaryPath;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn';
  const localBuild = pathResolve(moduleDir, '../../../../../../native/mixdog-spawn/target/release', binName);
  _binaryPath = existsSync(localBuild) ? localBuild : null;
  return _binaryPath;
}

function _setServerReferenced(server, referenced) {
  const method = referenced ? 'ref' : 'unref';
  try { server?.child?.[method]?.(); } catch {}
  try { server?.child?.stdin?.[method]?.(); } catch {}
  try { server?.child?.stdout?.[method]?.(); } catch {}
}

function _teardown(error) {
  const server = _server;
  _server = null;
  _lastFailureAt = Date.now();
  if (!server) return;
  for (const pending of server.pending.values()) {
    try { pending.fail(error || new Error('native spawn server exited')); } catch {}
  }
  server.pending.clear();
  try { server.child.kill(); } catch {}
}

function _ensureServer() {
  if (process.platform !== 'win32') return null;
  if (process.env.MIXDOG_SPAWN_SERVER === '0') return null;
  if (_server) return _server;
  if (Date.now() - _lastFailureAt < RESTART_BACKOFF_MS) return null;
  const binary = _resolveBinary();
  if (!binary) return null;
  let child;
  try {
    child = spawn(binary, [], {
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
    if (message?.ready === true) return;
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    pending.onMessage(message);
  });
  child.on('error', (error) => { if (_server === server) _teardown(error); });
  child.on('exit', () => { if (_server === server) _teardown(); });
  _setServerReferenced(server, false);
  _server = server;
  return server;
}

export async function warmNativeSpawnServer() {
  try {
    if (process.platform !== 'win32' || process.env.MIXDOG_SPAWN_SERVER === '0') return false;
    _resolveBinary();
    return Boolean(_ensureServer());
  } catch {
    return false;
  }
}

export function tryNativeSpawn({ shell, argv, spawnOptions = {}, cwd } = {}) {
  const server = _ensureServer();
  if (!server) return null;
  const id = ++server.sequence;
  const fake = new NativeSpawnChild(id, (cancelId) => {
    try { server.child.stdin.write(`${JSON.stringify({ cancel: cancelId })}\n`); } catch {}
  });
  const request = {
    id,
    program: String(shell || ''),
    args: Array.isArray(argv) ? argv.map(String) : [],
    cwd: String(spawnOptions.cwd || cwd || process.cwd()),
    env: spawnOptions.env && typeof spawnOptions.env === 'object' ? spawnOptions.env : undefined,
  };
  _setServerReferenced(server, true);
  const entry = {
    child: fake,
    fail(error) {
      server.pending.delete(id);
      const err = error instanceof Error ? error : new Error(String(error || 'native spawn failed'));
      if (fake.exitCode == null) {
        fake.exitCode = 1;
        fake.emit('error', err);
        fake.emit('close', 1, null);
      }
      if (server.pending.size === 0) _setServerReferenced(server, false);
    },
    onMessage(message) {
      const event = String(message?.event || '');
      if (event === 'spawned') {
        fake.pid = Number(message.pid) || undefined;
        fake.emit('spawn');
        return;
      }
      if (event === 'stdout' && message.text) fake.stdout.emit('data', String(message.text));
      else if (event === 'stderr' && message.text) fake.stderr.emit('data', String(message.text));
      else if (event === 'exit') {
        server.pending.delete(id);
        fake.exitCode = message.code == null ? null : Number(message.code);
        fake.signalCode = message.signal || null;
        fake._closed = true;
        fake.emit('close', fake.exitCode, fake.signalCode);
        if (server.pending.size === 0) _setServerReferenced(server, false);
      } else if (event === 'error') {
        const err = new Error(String(message.message || 'native spawn failed'));
        if (message.code) err.code = String(message.code);
        entry.fail(err);
      }
    },
  };
  server.pending.set(id, entry);
  try {
    server.child.stdin.write(`${JSON.stringify(request)}\n`);
  } catch (error) {
    server.pending.delete(id);
    return null;
  }
  return {
    child: fake,
    adoptErrorHandler(handler) {
      fake.on('error', handler);
    },
  };
}

export function _resetNativeSpawnClientForTest() {
  _teardown(new Error('test reset'));
  _binaryPath = undefined;
  _lastFailureAt = 0;
}
