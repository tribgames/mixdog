import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import { packageNativeToolPath } from '../../../../shared/native-tool-paths.mjs';
import { getPluginData } from '../../config.mjs';
import { ensureSpawnBinary, findCachedSpawnBinary } from '../spawn-binary-fetcher.mjs';

const RESTART_BACKOFF_MS = 30_000;
const SERVER_READY_TIMEOUT_MS = 5_000;
const REQUIRED_LIFECYCLE_CAPS = Object.freeze([
  'trackedForeground',
  'promoteTask',
  'cancelOwner',
]);

let _server = null;
let _binaryPath = undefined;
let _lastFailureAt = 0;
const _tasks = new Map();
const _taskEvents = new EventEmitter();

function nativeSpawnCompatibilityError(server) {
  if (!server?.ready) return null;
  const missingCaps = REQUIRED_LIFECYCLE_CAPS.filter((cap) => server.caps?.[cap] !== true);
  if (missingCaps.length === 0) return null;
  const error = new Error(
    `native spawn server is incompatible; missing required lifecycle capabilities: ${missingCaps.join(', ')}`,
  );
  error.code = 'NATIVE_SPAWN_INCOMPATIBLE';
  error.missingCaps = missingCaps;
  return error;
}

function assertNativeSpawnCompatibility(server) {
  const error = nativeSpawnCompatibilityError(server);
  if (error) throw error;
}

export function _assertNativeSpawnCapabilitiesForTest(caps = {}) {
  assertNativeSpawnCompatibility({ ready: true, caps });
  return true;
}

// Warm-standby correction. The spawn server stamps a task with the moment its
// PROCESS was created, which for a pre-spawned standby shell is up to the
// standby TTL (2 min) before the command was ever fed to it — every consumer
// then measured the idle wait as command runtime. The runner registers the
// real feed moment here, and it wins over the server value for the task's
// whole life so job records, completion elapsed and status readouts agree.
const STARTED_AT_OVERRIDE_LIMIT = 512;
const _startedAtOverrides = new Map();

export function setNativeTaskStartedAt(jobId, startedAtMs) {
  const key = String(jobId || '').trim();
  const ms = Math.floor(Number(startedAtMs));
  if (!key || !Number.isFinite(ms) || ms <= 0) return;
  // Insertion-ordered eviction: a long-lived host must not accumulate one
  // entry per command forever. Overrides outlive their task on purpose (a
  // post-completion status refresh would otherwise restore the raw value).
  if (_startedAtOverrides.size >= STARTED_AT_OVERRIDE_LIMIT) {
    const oldest = _startedAtOverrides.keys().next();
    if (!oldest.done) _startedAtOverrides.delete(oldest.value);
  }
  _startedAtOverrides.set(key, ms);
  const known = _tasks.get(key);
  if (known) known.startedAt = new Date(ms).toISOString();
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || !task.jobId) return null;
  const jobId = String(task.jobId);
  const override = _startedAtOverrides.get(jobId);
  const startedAtMs = override || Number(task.startedAtMs) || Date.now();
  const finishedAtMs = Number(task.finishedAtMs) || 0;
  return {
    jobId,
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
    this._pending = [];
  }
  setEncoding() { return this; }
  emit(event, ...args) {
    if (event === 'data' && this.listenerCount('data') === 0) {
      if (args[0] != null) this._pending.push(args[0]);
      return false;
    }
    return super.emit(event, ...args);
  }
  on(event, listener) {
    const ret = super.on(event, listener);
    if (event === 'data' && this._pending.length > 0) {
      const pending = this._pending;
      this._pending = [];
      queueMicrotask(() => {
        for (const chunk of pending) listener(chunk);
      });
    }
    return ret;
  }
}

export class NativeSpawnChild extends EventEmitter {
  constructor(id, cancel, send = null) {
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
    this._send = send;
    this._closed = false;
  }

  // stdinPipe children only (warm shell standby): forward script text to the
  // child's stdin via the spawn server. No-ops (false) when the child was
  // spawned without stdinPipe or the server link is gone.
  writeStdin(text, { close = false } = {}) {
    if (this._closed || this.killed || typeof this._send !== 'function') return false;
    return this._send({
      stdinWrite: this._id,
      data: String(text ?? ''),
      ...(close ? { close: true } : {}),
    });
  }

  endStdin() {
    if (typeof this._send !== 'function') return false;
    return this._send({ stdinClose: this._id });
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
  const localBuild = pathResolve(
    moduleDir,
    '../../../../../../native/mixdog-spawn/target/release',
    binName,
  );
  if (existsSync(localBuild)) {
    _binaryPath = localBuild;
    return _binaryPath;
  }
  const installed = packageNativeToolPath('spawn');
  if (existsSync(installed)) {
    _binaryPath = installed;
    return _binaryPath;
  }
  _binaryPath = findCachedSpawnBinary(getPluginData());
  return _binaryPath;
}

function _setServerReferenced(server, referenced) {
  const method = referenced ? 'ref' : 'unref';
  try { server?.child?.[method]?.(); } catch {}
  try { server?.child?.stdin?.[method]?.(); } catch {}
  try { server?.child?.stdout?.[method]?.(); } catch {}
}

// Referenced only while a NON-idle request is pending. Idle requests (parked
// warm shell standbys) live for minutes-to-hours; counting them would pin the
// host event loop — a one-shot CLI or test runner could never exit.
function _recomputeServerRef(server) {
  let active = false;
  for (const entry of server.pending.values()) {
    if (!entry.idle) { active = true; break; }
  }
  _setServerReferenced(server, active);
}

/** Mark a pending spawn request idle (parked) or active. Idle requests do not
 *  keep the host process alive. Returns false when the request is gone. */
export function setNativeSpawnRequestIdle(child, idle = true) {
  const server = _server;
  const entry = server?.pending?.get?.(Number(child?._id));
  if (!entry) return false;
  entry.idle = idle === true;
  _recomputeServerRef(server);
  return true;
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

export async function shutdownNativeSpawnServer(reason = 'process-exit', timeoutMs = 1_000) {
  const server = _server;
  if (!server) return true;
  const child = server.child;
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(true));
    child.once('error', () => resolve(true));
  });
  try { child.stdin?.end?.(); } catch {}
  _teardown(new Error(`native spawn server shutdown (${reason})`));
  let timer;
  const stopped = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(10, Number(timeoutMs) || 1_000));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!stopped) {
    try { child.kill('SIGKILL'); } catch {}
  }
  return stopped;
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
  const server = { child, pending: new Map(), sequence: 0, ready: false, caps: {} };
  let resolveReady;
  server.readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const settleReady = (value) => {
    if (!resolveReady) return;
    const resolve = resolveReady;
    resolveReady = null;
    resolve(value);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.ready === true) {
      server.caps = (message.caps && typeof message.caps === 'object') ? message.caps : {};
      server.ready = true;
      settleReady(true);
      return;
    }
    const event = String(message?.event || '');
    if (event === 'task_released') {
      const jobId = String(message?.jobId || '');
      if (jobId) {
        _tasks.delete(jobId);
        _startedAtOverrides.delete(jobId);
      }
    } else if (event.startsWith('task_')) {
      acceptTask(message);
    }
    const pending = server.pending.get(Number(message?.id));
    if (!pending) return;
    pending.onMessage(message);
  });
  child.on('error', (error) => {
    settleReady(false);
    if (_server === server) _teardown(error);
  });
  child.on('exit', () => {
    settleReady(false);
    if (_server === server) _teardown();
  });
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
  if (_server?.ready) {
    assertNativeSpawnCompatibility(_server);
    return true;
  }
  let binary = _resolveBinary();
  if (!binary) {
    binary = await ensureSpawnBinary(getPluginData());
    _binaryPath = binary;
  }
  const server = _ensureServer();
  if (!server) {
    throw Object.assign(new Error('verified native spawn server could not be started'), {
      code: 'NATIVE_SPAWN_UNAVAILABLE',
    });
  }
  if (!server.ready) {
    let timer;
    let ready;
    _setServerReferenced(server, true);
    try {
      ready = await Promise.race([
        server.readyPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), SERVER_READY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (_server === server) _recomputeServerRef(server);
    }
    if (!ready) {
      if (_server === server) _teardown(new Error('native spawn server ready timeout'));
      throw Object.assign(new Error('verified native spawn server did not become ready'), {
        code: 'NATIVE_SPAWN_UNAVAILABLE',
      });
    }
  }
  assertNativeSpawnCompatibility(server);
  return true;
}

export function tryNativeSpawn({ shell, argv, spawnOptions = {}, cwd } = {}) {
  const server = _ensureServer();
  if (!server) return null;
  assertNativeSpawnCompatibility(server);
  const id = ++server.sequence;
  const fake = new NativeSpawnChild(id, (cancelId) => {
    try { server.child.stdin.write(`${JSON.stringify({ cancel: cancelId })}\n`); } catch {}
  }, (payload) => {
    try {
      server.child.stdin.write(`${JSON.stringify({ id: ++server.sequence, ...payload })}\n`);
      return true;
    } catch { return false; }
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
    rawOutput: spawnOptions.rawOutput === true,
    ...(spawnOptions.stdinPipe === true ? { stdinPipe: true } : {}),
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
      _recomputeServerRef(server);
    },
    onMessage(message) {
      const event = String(message?.event || '');
      if (event === 'spawned') {
        fake.pid = Number(message.pid) || undefined;
        fake.emit('spawn');
        return;
      }
      if (event === 'stdout' && (message.dataBase64 || message.text)) {
        const chunk = message.dataBase64
          ? Buffer.from(String(message.dataBase64), 'base64')
          : String(message.text);
        fake.stdout.emit('data', chunk);
      }
      else if (event === 'stderr' && (message.dataBase64 || message.text)) {
        const chunk = message.dataBase64
          ? Buffer.from(String(message.dataBase64), 'base64')
          : String(message.text);
        fake.stderr.emit('data', chunk);
      }
      else if (event === 'root_exit') {
        fake.exitCode = message.code == null ? null : Number(message.code);
        fake.signalCode = message.signal || null;
        fake.emit('exit', fake.exitCode, fake.signalCode);
      }
      else if (event === 'exit') {
        server.pending.delete(id);
        fake.exitCode = message.code == null ? null : Number(message.code);
        fake.signalCode = message.signal || null;
        fake._closed = true;
        fake.emit('close', fake.exitCode, fake.signalCode);
        _recomputeServerRef(server);
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
    attachErrorHandler(handler) {
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

export function cancelNativeTasks({ ownerSessionId = null } = {}) {
  const owner = String(ownerSessionId || '').trim();
  if (!owner) return { cancelled: 0 };
  const running = [..._tasks.values()].filter((task) =>
    task.status === 'running' && String(task.ownerSessionId || '') === owner);
  const server = _server;
  if (server?.caps?.cancelOwner === true) {
    try {
      server.child.stdin.write(`${JSON.stringify({
        id: ++server.sequence,
        cancelOwnerSession: owner,
      })}\n`);
    } catch {}
  }
  // Also issue direct per-task cancellation for entries already visible in
  // this client so teardown does not wait on the owner-wide command round trip.
  for (const task of running) {
    try { cancelNativeTask(task.jobId); } catch {}
  }
  return { cancelled: running.length };
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

function requestNativeTaskState(jobId, payload, errorLabel) {
  const key = String(jobId || '').trim();
  const server = _server;
  if (!server || !key) return null;
  const id = ++server.sequence;
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (task, error = null) => {
      if (timer) clearTimeout(timer);
      server.pending.delete(id);
      _recomputeServerRef(server);
      if (error) reject(error);
      else resolve(task);
    };
    server.pending.set(id, {
      fail(error) {
        finish(null, error instanceof Error ? error : new Error(String(error || `${errorLabel} failed`)));
      },
      onMessage(message) {
        const event = String(message?.event || '');
        if (event === 'task_started' || event === 'task_status') {
          finish(getNativeTask(key));
        } else if (event === 'error') {
          const error = new Error(String(message.message || `${errorLabel} failed`));
          if (message.code) error.code = String(message.code);
          finish(null, error);
        }
      },
    });
    _setServerReferenced(server, true);
    try {
      server.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (error) {
      finish(null, error);
      return;
    }
    timer = setTimeout(() => {
      finish(null, Object.assign(new Error(`${errorLabel} timeout`), { code: 'ETIMEDOUT' }));
    }, 5_000);
    timer.unref?.();
  });
}

export function trackNativeForegroundTask({
  child,
  jobId,
  command = '',
  cwd = '',
  shellType = null,
  ownerSessionId = null,
  clientHostPid = null,
} = {}) {
  const requestId = Number(child?._id) || 0;
  const server = _server;
  if (!server || server.caps?.trackedForeground !== true || !requestId) return null;
  return requestNativeTaskState(jobId, {
    track: requestId,
    jobId,
    command,
    cwd,
    shellType,
    ownerSessionId,
    clientHostPid,
  }, 'native task tracking');
}

export function promoteNativeTask({
  jobId,
  command = '',
  cwd = '',
  timeoutMs = 0,
  shellType = null,
  ownerSessionId = null,
  clientHostPid = null,
} = {}) {
  const key = String(jobId || '').trim();
  const server = _server;
  if (server?.caps?.promoteTask !== true || !getNativeTask(key)) return null;
  return requestNativeTaskState(key, {
    promoteTask: key,
    timeoutMs,
    command,
    cwd,
    shellType,
    ownerSessionId,
    clientHostPid,
  }, 'native task promotion');
}

// Capability handshake: true only after the connected spawn server announced
// stdinPipe support in its ready line. An older binary silently ignores the
// unknown stdinPipe field and gives the child a null stdin — a standby taken
// in that state would run an EMPTY script and report exit 0 without ever
// executing the command. Gate the warm-standby feature on this.
export function nativeSpawnSupportsStdinPipe() {
  return _server?.caps?.stdinPipe === true;
}

export function _resetNativeSpawnClientForTest() {
  _teardown(new Error('test reset'));
  _binaryPath = undefined;
  _lastFailureAt = 0;
  _tasks.clear();
  _taskEvents.removeAllListeners();
}

export function _setNativeSpawnBinaryForTest(binaryPath) {
  const path = String(binaryPath || '');
  if (!path || !existsSync(path)) throw new Error(`native spawn test binary not found: ${path}`);
  if (_server) _teardown(new Error('native spawn test binary replaced'));
  _binaryPath = path;
  _lastFailureAt = 0;
}
