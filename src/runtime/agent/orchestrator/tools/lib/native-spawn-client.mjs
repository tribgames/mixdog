import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import { resolveNativeAssetPath } from '../../../../shared/native-assets.mjs';

const RESTART_BACKOFF_MS = 30_000;

let _server = null;
let _binaryPath = undefined;
let _lastFailureAt = 0;
const _tasks = new Map();
const _pidToRequest = new Map();
const _taskEvents = new EventEmitter();

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || !task.jobId) return null;
  const startedAtMs = Number(task.startedAtMs) || Date.now();
  const finishedAtMs = Number(task.finishedAtMs) || 0;
  return {
    jobId: String(task.jobId),
    requestId: Number(task.requestId) || 0,
    pid: Number(task.pid) || null,
    kind: 'native',
    status: String(task.status || 'running'),
    command: String(task.command || ''),
    cwd: String(task.cwd || ''),
    shellType: task.shellType ? String(task.shellType) : null,
    ownerSessionId: task.ownerSessionId ? String(task.ownerSessionId) : null,
    clientHostPid: Number(task.clientHostPid) || null,
    exitCode: task.exitCode == null ? null : Number(task.exitCode),
    signal: task.signal || null,
    timedOut: task.timedOut === true,
    killed: task.killed === true,
    error: task.error ? String(task.error) : null,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: finishedAtMs > 0 ? new Date(finishedAtMs).toISOString() : null,
    stdoutBytes: Math.max(0, Number(task.stdoutBytes) || 0),
    stderrBytes: Math.max(0, Number(task.stderrBytes) || 0),
    stdoutPreview: String(task.stdoutPreview || ''),
    stderrPreview: String(task.stderrPreview || ''),
    mergeStderr: false,
  };
}

function acceptTask(message) {
  const task = normalizeTask(message?.task);
  if (!task) return null;
  _tasks.set(task.jobId, task);
  _taskEvents.emit(task.jobId, task);
  return task;
}

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
  _binaryPath = resolveNativeAssetPath('spawn');
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
  const message = error?.message || 'native spawn server exited';
  for (const [jobId, task] of _tasks) {
    if (task.status !== 'running') continue;
    const failed = {
      ...task,
      status: 'failed',
      error: task.error || message,
      finishedAt: new Date().toISOString(),
    };
    _tasks.set(jobId, failed);
    _taskEvents.emit(jobId, { ...failed });
  }
  try { server.child.kill(); } catch {}
}

function _ensureServer() {
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
    if (String(message?.event || '').startsWith('task_')) acceptTask(message);
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    pending.onMessage(message);
  });
  child.on('error', (error) => { if (_server === server) _teardown(error); });
  child.on('exit', () => { if (_server === server) _teardown(); });
  child.stdin.on('error', (error) => { if (_server === server) _teardown(error); });
  _setServerReferenced(server, false);
  _server = server;
  return server;
}

export async function warmNativeSpawnServer() {
  try {
    return await ensureNativeSpawnServer();
  } catch {
    return false;
  }
}

export async function ensureNativeSpawnServer() {
  if (_server) return true;
  const binary = _resolveBinary();
  if (!binary) {
    throw Object.assign(new Error(
      'required mixdog-spawn asset is missing; reinstall Mixdog or build native/mixdog-spawn locally',
    ), {
      code: 'NATIVE_SPAWN_UNAVAILABLE',
    });
  }
  if (!_ensureServer()) {
    throw Object.assign(new Error('verified native spawn server could not be started'), {
      code: 'NATIVE_SPAWN_UNAVAILABLE',
    });
  }
  return true;
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
    background: spawnOptions.background === true,
    jobId: spawnOptions.jobId || undefined,
    timeoutMs: Math.max(0, Number(spawnOptions.timeoutMs) || 0),
    outputLimit: Math.max(0, Number(spawnOptions.outputLimit) || 0),
    mergeStderr: spawnOptions.mergeStderr === true,
    command: spawnOptions.command || undefined,
    shellType: spawnOptions.shellType || undefined,
    ownerSessionId: spawnOptions.ownerSessionId || undefined,
    clientHostPid: Number(spawnOptions.clientHostPid) || undefined,
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
        if (fake.pid) _pidToRequest.set(fake.pid, id);
        fake.emit('spawn');
        return;
      }
      if (event === 'stdout' && message.text) fake.stdout.emit('data', String(message.text));
      else if (event === 'stderr' && message.text) fake.stderr.emit('data', String(message.text));
      else if (event === 'root_exit') {
        fake.exitCode = message.code == null ? null : Number(message.code);
        fake.signalCode = message.signal || null;
        fake.emit('exit', fake.exitCode, fake.signalCode);
      }
      else if (event === 'exit') {
        server.pending.delete(id);
        if (fake.pid) _pidToRequest.delete(fake.pid);
        fake.exitCode = message.code == null ? null : Number(message.code);
        fake.signalCode = message.signal || null;
        fake._closed = true;
        fake.emit('close', fake.exitCode, fake.signalCode);
        if (server.pending.size === 0) _setServerReferenced(server, false);
      } else if (event === 'error') {
        const detail = String(message.message || 'native spawn failed');
        const err = new Error(message.code ? `${message.code}: ${detail}` : detail);
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

export function getNativeTask(jobId) {
  const task = _tasks.get(String(jobId || ''));
  return task ? { ...task } : null;
}

export function listNativeTasks() {
  return [..._tasks.values()].map((task) => ({ ...task }));
}

export function subscribeNativeTask(jobId, listener) {
  const key = String(jobId || '');
  if (!key || typeof listener !== 'function') return () => {};
  _taskEvents.on(key, listener);
  return () => _taskEvents.removeListener(key, listener);
}

export function cancelNativeTask(jobId) {
  const key = String(jobId || '');
  const task = getNativeTask(key);
  const server = _ensureServer();
  if (!server || !task) return null;
  server.child.stdin.write(`${JSON.stringify({ id: ++server.sequence, cancelTask: key })}\n`);
  return task;
}

export function waitNativeTask(jobId, timeoutMs = 30_000) {
  const key = String(jobId || '');
  const current = getNativeTask(key);
  if (!current || current.status !== 'running') return Promise.resolve(current);
  return new Promise((resolve) => {
    let timer = null;
    const done = (task) => {
      if (task?.status === 'running') return;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(task ? { ...task } : null);
    };
    const unsubscribe = subscribeNativeTask(key, done);
    timer = setTimeout(() => {
      unsubscribe();
      resolve(getNativeTask(key));
    }, Math.max(1, Number(timeoutMs) || 30_000));
    timer.unref?.();
  });
}

export async function startNativeTask({
  program,
  argv,
  cwd,
  env,
  timeoutMs = 0,
  outputLimit = 0,
  mergeStderr = false,
  command = '',
  shellType = null,
  ownerSessionId = null,
  clientHostPid = null,
  jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  await ensureNativeSpawnServer();
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (task, error = null) => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(task);
    };
    const unsubscribe = subscribeNativeTask(jobId, (task) => {
      if (task) finish({ ...task });
    });
    const native = tryNativeSpawn({
      shell: program,
      argv,
      cwd,
      spawnOptions: {
        cwd,
        env,
        background: true,
        jobId,
        timeoutMs,
        outputLimit,
        mergeStderr,
        command,
        shellType,
        ownerSessionId,
        clientHostPid,
      },
    });
    if (!native) {
      finish(null, Object.assign(new Error('native spawn server unavailable'), { code: 'NATIVE_SPAWN_UNAVAILABLE' }));
      return;
    }
    native.child.once('error', (error) => finish(null, error));
    timer = setTimeout(() => {
      try { native.child.kill(); } catch {}
      finish(null, Object.assign(new Error('native task spawn timeout'), { code: 'ETIMEDOUT' }));
    }, 15_000);
    timer.unref?.();
  });
}

export function adoptNativeTaskByPid({
  pid,
  command = '',
  cwd = '',
  timeoutMs = 0,
  shellType = null,
  ownerSessionId = null,
  clientHostPid = null,
  jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  const requestId = _pidToRequest.get(Number(pid));
  const server = _ensureServer();
  if (!server || !requestId) return null;
  const id = ++server.sequence;
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (task, error = null) => {
      if (timer) clearTimeout(timer);
      server.pending.delete(id);
      if (server.pending.size === 0) _setServerReferenced(server, false);
      if (error) reject(error);
      else resolve(task);
    };
    server.pending.set(id, {
      fail(error) {
        finish(null, error instanceof Error ? error : new Error(String(error || 'native adoption failed')));
      },
      onMessage(message) {
        const event = String(message?.event || '');
        if (event === 'task_started') {
          finish(getNativeTask(jobId));
        } else if (event === 'error') {
          const error = new Error(String(message.message || 'native adoption failed'));
          if (message.code) error.code = String(message.code);
          finish(null, error);
        }
      },
    });
    _setServerReferenced(server, true);
    try {
      server.child.stdin.write(`${JSON.stringify({
        id,
        adopt: requestId,
        jobId,
        timeoutMs,
        command,
        cwd,
        shellType,
        ownerSessionId,
        clientHostPid,
      })}\n`);
    } catch (error) {
      finish(null, error);
      return;
    }
    timer = setTimeout(() => {
      finish(null, Object.assign(new Error('native task adoption timeout'), { code: 'ETIMEDOUT' }));
    }, 5_000);
    timer.unref?.();
  });
}

export function _resetNativeSpawnClientForTest() {
  _teardown(new Error('test reset'));
  _binaryPath = undefined;
  _lastFailureAt = 0;
  _tasks.clear();
  _pidToRequest.clear();
  _taskEvents.removeAllListeners();
}

export function _setNativeSpawnBinaryForTest(binaryPath) {
  const path = String(binaryPath || '');
  if (!path || !existsSync(path)) throw new Error(`native spawn test binary not found: ${path}`);
  if (_server) _teardown(new Error('native spawn test binary replaced'));
  _binaryPath = path;
  _lastFailureAt = 0;
}
