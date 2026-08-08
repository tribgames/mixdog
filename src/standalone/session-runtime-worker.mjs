// Child-process host for a shard of session runtimes.
//
// Provider parsing, transcript projection, tool execution, and runtime timers
// stay on this event loop. The machine daemon receives only identity-preserving
// state deltas and remains free to serve health, input, and abort dispatch.
process.env.MIXDOG_SESSION_SHARD = '1';
// Pid-scoped shard marker: agent shard spread defaults ON only when this
// exact process is a shard child. A plain MIXDOG_SESSION_SHARD flag leaks to
// every grandchild (shell tools, test runners) through env inheritance.
process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid);
process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';

import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { sanitizeForWire } from './session-service.mjs';
import { disposeSessionRuntimeRecord } from './session-runtime-record.mjs';
import { diffSessionState } from './session-state-patch.mjs';

const records = new Map();
let sessionModulePromise = null;
let stopping = false;

function sessionModule() {
  sessionModulePromise ??= import('../tui/session-local.mjs');
  return sessionModulePromise;
}

function send(message) {
  return safeIpcSend(process, message);
}

function errorBody(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'session shard call failed'),
    stack: typeof error?.stack === 'string' ? error.stack : null,
    statusCode: Number(error?.statusCode) || null,
  };
}

function projectState(record, raw) {
  if (!raw || typeof raw !== 'object') return sanitizeForWire(raw);
  if (record.source === raw) return record.projected;
  const fields = record.fields;
  const items = record.items;
  const nextItems = new Map();
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'items' && Array.isArray(value)) {
      out.items = value.map((item) => {
        const cached = items.get(item);
        if (cached !== undefined) {
          nextItems.set(item, cached);
          return cached;
        }
        const cloned = sanitizeForWire(item);
        nextItems.set(item, cloned);
        return cloned;
      });
      continue;
    }
    const cached = fields.get(key);
    if (cached && cached.source === value) {
      out[key] = cached.value;
      continue;
    }
    const cloned = sanitizeForWire(value);
    if (cloned === undefined) continue;
    fields.set(key, { source: value, value: cloned });
    out[key] = cloned;
  }
  record.items = nextItems;
  record.source = raw;
  record.projected = out;
  return out;
}

function publish(record, forceFull = false) {
  if (!record || record.disposed) return;
  const projected = projectState(record, record.runtime.getState?.() || {});
  const previous = record.published;
  if (!forceFull && projected === previous) return;
  record.published = projected;
  record.revision += 1;
  send({
    type: 'state',
    runtimeId: record.id,
    revision: record.revision,
    ...(forceFull || !previous
      ? { full: projected }
      : { patch: diffSessionState(previous, projected) }),
  });
}

async function createRuntime(message) {
  const module = await sessionModule();
  const runtime = await module.createLocalSessionRuntime(message.options || {});
  const record = {
    id: message.runtimeId,
    runtime,
    unsubscribe: null,
    disposed: false,
    source: null,
    projected: null,
    published: null,
    fields: new Map(),
    items: new Map(),
    revision: 0,
  };
  records.set(record.id, record);
  record.unsubscribe = runtime.subscribe?.(() => publish(record)) ?? null;
  publish(record, true);
  return { created: true };
}

async function callRuntime(message) {
  const record = records.get(message.runtimeId);
  if (!record || record.disposed) throw new Error(`session shard runtime ${message.runtimeId} is unavailable`);
  const method = String(message.method || '');
  const target = record.runtime?.[method];
  if (typeof target !== 'function') throw new TypeError(`session action ${method} is unavailable`);
  if (method === 'dispose') {
    const value = await disposeSessionRuntimeRecord(records, record, message.args);
    return sanitizeForWire(value);
  }
  const value = await target.apply(record.runtime, Array.isArray(message.args) ? message.args : []);
  publish(record);
  return sanitizeForWire(value);
}

async function prewarm() {
  const module = await sessionModule();
  module.preloadSessionRuntimeModule?.();
  module.preloadAgentLoopRuntime?.();
  module.preloadKeychainSecrets?.();
  module.preloadProviderRuntime?.();
  module.preloadMemoryRuntime?.();
  return { ready: true };
}

/** Shard-local workload telemetry for the daemon status panel. Gate modules
 *  are already resident once any tool has run; loading them here otherwise is
 *  cheap and side-effect-free. */
async function workloadSnapshot() {
  const [gate, workload, resources] = await Promise.all([
    import('../runtime/shared/child-spawn-gate.mjs'),
    import('../runtime/shared/tool-workload-gates.mjs'),
    import('../runtime/shared/resource-admission.mjs'),
  ]);
  return {
    runtimes: records.size,
    childSpawns: gate.snapshot(),
    toolIo: workload.toolWorkloadSnapshot(),
    resources: resources.resourceAdmission.snapshot(),
  };
}

async function stopAll(reason = 'session shard shutdown') {
  if (stopping) return;
  stopping = true;
  for (const record of [...records.values()]) {
    try {
      await disposeSessionRuntimeRecord(
        records,
        record,
        [reason, { keepBackgroundWork: true }],
      );
    } catch {}
  }
  records.clear();
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  const requestId = String(message.requestId || '');
  void (async () => {
    if (message.type === 'create') return createRuntime(message);
    if (message.type === 'call') return callRuntime(message);
    if (message.type === 'snapshot') {
      const record = records.get(message.runtimeId);
      if (!record) throw new Error(`session shard runtime ${message.runtimeId} is unavailable`);
      publish(record, true);
      return { published: true };
    }
    if (message.type === 'prewarm') return prewarm();
    if (message.type === 'workload') return workloadSnapshot();
    if (message.type === 'shutdown') {
      await stopAll(message.reason);
      return { stopped: true };
    }
    throw new Error(`unknown session shard message ${message.type}`);
  })().then((value) => {
    if (requestId) send({ type: 'response', requestId, ok: true, value: value ?? null });
    if (message.type === 'shutdown') setImmediate(() => process.exit(0));
  }).catch((error) => {
    if (requestId) send({ type: 'response', requestId, ok: false, error: errorBody(error) });
  });
});

process.on('disconnect', () => {
  void stopAll('session shard parent disconnected').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void stopAll('session shard SIGTERM').finally(() => process.exit(0));
});
