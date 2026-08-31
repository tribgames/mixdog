// Supervised child process for ONE session runtime shard.
//
// Provider parsing, transcript projection, tool execution, and runtime timers
// stay on this event loop. The machine daemon receives only identity-preserving
// state deltas and remains free to serve health, input, and abort dispatch.
//
// This process is one of a BOUNDED set of identical shards (see
// session-runtime-host.mjs): the host routes each session/dispatch to a shard
// deterministically, so a saturated or crashed shard degrades only the work it
// owns instead of every runtime on the machine. Shard-crossing facts —
// machine-wide spawn leases and account-wide provider cooldowns — are
// coordinated through the host, never assumed process-local.
process.env.MIXDOG_SESSION_RUNTIME_WORKER = '1';
// Pid-scoped marker: child tools inherit the plain flag, so callers that need
// the actual runtime worker must also verify this exact pid.
process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = String(process.pid);
process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';

import { getEventListeners } from 'node:events';
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { sanitizeForWire } from './session-service.mjs';
import { disposeSessionRuntimeRecord } from './session-runtime-record.mjs';
import { releaseAllComputerSessions } from '../runtime/computer-bridge/client.mjs';
import { diffSessionState } from './session-state-patch.mjs';
import {
  applyProviderCooldown,
  mergeKnownProviderCooldown,
  providerCooldownAdvanced,
  readProviderCooldown,
} from './session-runtime-provider-cooldown.mjs';
import {
  reportRuntimeAbortListenerPressure,
  SESSION_RUNTIME_WORKER_UNHEALTHY_EVENT,
  startRuntimeEventLoopLagMonitor,
} from '../runtime/shared/session-runtime-health.mjs';

// Shard identity. The host runs a BOUNDED set of identical runtime children so
// that provider parsing, tool results and transcript projection for unrelated
// sessions no longer share one event loop; this process owns exactly the
// sessions/dispatches the host routed to this shard index.
const SHARD_INDEX = Math.max(0, Math.floor(Number(process.env.MIXDOG_SESSION_RUNTIME_SHARD) || 0));

const records = new Map();
let sessionModulePromise = null;
let stopping = false;
let unhealthyDetail = null;
let unhealthyReported = false;
const pendingAbortPressureChecks = new WeakSet();
const ABORT_PRESSURE_RETENTION_CHECK_MS = 30_000;

// Reporting is bound to DETECTION, not to a successful runtime call: an idle
// worker (or one whose every call fails) would otherwise never be recycled.
function reportUnhealthy() {
  if (stopping || unhealthyReported || !unhealthyDetail) return;
  unhealthyReported = true;
  send({ type: 'unhealthy', detail: unhealthyDetail });
}

process.on(SESSION_RUNTIME_WORKER_UNHEALTHY_EVENT, (detail) => {
  if (stopping || unhealthyDetail) return;
  unhealthyDetail = sanitizeForWire(detail) || { reason: 'session runtime worker unhealthy' };
  process.stderr.write(
    `[session-runtime-health] shard ${SHARD_INDEX}: ${unhealthyDetail.reason || 'unhealthy'}\n`,
  );
  reportUnhealthy();
});

process.on('warning', (warning) => {
  if (warning?.name !== 'MaxListenersExceededWarning') return;
  if (!/AbortSignal/i.test(String(warning?.message || ''))) return;
  const target = warning?.target;
  if ((!target || (typeof target !== 'object' && typeof target !== 'function'))
    || pendingAbortPressureChecks.has(target)) return;
  pendingAbortPressureChecks.add(target);
  const timer = setTimeout(() => {
    pendingAbortPressureChecks.delete(target);
    let retained = 0;
    try { retained = getEventListeners(target, 'abort').length; } catch {}
    reportRuntimeAbortListenerPressure(warning, Date.now(), retained);
  }, ABORT_PRESSURE_RETENTION_CHECK_MS);
  timer.unref?.();
});

function sessionModule() {
  sessionModulePromise ??= import('../tui/session-local.mjs');
  return sessionModulePromise;
}

function send(message) {
  return safeIpcSend(process, message);
}

// ── Per-shard event-loop lag ───────────────────────────────────────────────
// The daemon can only measure its OWN loop; a shard saturated by provider
// parsing or a runaway tool is invisible there. Sampling here and reporting to
// the host gives per-shard saturation telemetry and lets the host stop placing
// NEW work on this shard. It never triggers a kill: this process still owns
// accepted input and in-flight turns.
let lastLagSample = null;

const stopEventLoopLagMonitor = startRuntimeEventLoopLagMonitor({
  onSample: (sample) => {
    lastLagSample = sample;
    if (stopping) return;
    send({ type: 'event-loop-lag', shard: SHARD_INDEX, sample });
    void publishProviderCooldown();
  },
});

// ── Cross-shard provider cooldown ──────────────────────────────────────────
// Fast-mode capacity cooldown is an ACCOUNT-wide fact held in process-local
// state. With several shards, one shard discovering the drained pool must not
// leave siblings hammering it, so cooldowns are published to the host and
// replayed into every other shard. Only the module's public API is used: a
// replay is expressed as the same capacity rejection the discovering shard saw.
let fastModePromise = null;
let fastModePolicy = null;
let lastCooldownSent = { untilMs: 0, disabledReason: null };
let admissionModulePromise = null;
let cooldownBridgeUnsubscribe = null;
let cooldownBridgePromise = null;

function fastModeModule() {
  fastModePromise ??= import('../runtime/agent/orchestrator/providers/anthropic-fast-mode.mjs')
    .then((policy) => { fastModePolicy = policy; return policy; })
    .catch(() => null);
  return fastModePromise;
}

function admissionSchedulerModule() {
  admissionModulePromise ??= import('../runtime/agent/orchestrator/providers/admission-scheduler.mjs')
    .catch(() => null);
  return admissionModulePromise;
}

/**
 * Subscribe to the provider admission scheduler's cooldown events so a 429
 * observed here reaches sibling shards ON THE EVENT — waiting for the next
 * telemetry tick would leave every other shard probing a pool this process
 * already knows is drained. Idempotent and safe to call from any provider
 * entry point.
 */
function ensureProviderCooldownBridge() {
  if (cooldownBridgeUnsubscribe || cooldownBridgePromise || stopping) return;
  cooldownBridgePromise = admissionSchedulerModule().then((module) => {
    if (!module || stopping || cooldownBridgeUnsubscribe) return;
    cooldownBridgeUnsubscribe = module.providerAdmissionScheduler.onCooldownEvent((event) => {
      publishProviderCooldownNow(event);
    });
  }).catch(() => { /* provider graph is absent in this shard */ })
    .finally(() => { cooldownBridgePromise = null; });
}

function normalizeAdmissionCooldownEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  if (type === 'cooldown') {
    const key = String(event.key || '');
    const cooldownUntil = Number(event.cooldownUntil) || 0;
    if (!key || cooldownUntil <= Date.now()) return null;
    return { type, key, cooldownUntil };
  }
  if (type === 'reset') {
    return { type, provider: event.provider ? String(event.provider) : null };
  }
  return null;
}

/**
 * Synchronous publish path. Costs one comparison when nothing changed, so it
 * can be called from provider/runtime boundaries and from the cooldown event
 * itself without waiting on any import.
 */
function publishProviderCooldownNow(admissionEvent = null) {
  if (stopping) return false;
  const admission = normalizeAdmissionCooldownEvent(admissionEvent);
  const observed = fastModePolicy ? readProviderCooldown(fastModePolicy) : null;
  const advanced = Boolean(observed) && providerCooldownAdvanced(lastCooldownSent, observed);
  if (!admission && !advanced) return false;
  if (advanced) lastCooldownSent = mergeKnownProviderCooldown(lastCooldownSent, observed);
  send({
    type: 'provider-cooldown',
    shard: SHARD_INDEX,
    cooldown: observed || { untilMs: 0, disabledReason: null, observedAt: Date.now() },
    ...(admission ? { admission } : {}),
  });
  return true;
}

/** Backstop sweep (telemetry tick): loads the policy module if provider work
 *  has happened, then reuses the synchronous path. */
async function publishProviderCooldown() {
  // Only shards that actually run provider work carry cooldown state.
  if (stopping || (!agentGraphPromise && records.size === 0)) return;
  const policy = await fastModeModule();
  if (!policy || stopping) return;
  publishProviderCooldownNow();
}

async function applyReplayedProviderCooldown(frame) {
  const cooldown = frame?.cooldown ?? frame ?? null;
  const admission = frame?.admission && typeof frame.admission === 'object' ? frame.admission : null;
  if (admission) {
    const module = await admissionSchedulerModule();
    if (module) {
      // applyExternalCooldown/resetCooldowns are the documented cross-process
      // seams: neither re-emits for a broadcast that changed nothing, so the
      // replay cannot loop between shards.
      if (admission.type === 'cooldown') {
        module.providerAdmissionScheduler.applyExternalCooldown(
          String(admission.key || ''),
          Number(admission.cooldownUntil) || 0,
        );
      } else if (admission.type === 'reset') {
        module.resetProviderAdmissionCooldowns(admission.provider || null);
      }
    }
  }
  const policy = await fastModeModule();
  if (!policy) return Boolean(admission);
  const applied = applyProviderCooldown(policy, cooldown);
  // A replayed cooldown is not a local discovery: suppress the echo back.
  lastCooldownSent = mergeKnownProviderCooldown(lastCooldownSent, cooldown);
  return applied || Boolean(admission);
}

process.on('mixdog:turn-timing', (row = {}) => {
  send({
    type: 'turn-timing',
    row: sanitizeForWire(row) || {},
  });
});

function errorBody(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'session runtime call failed'),
    stack: typeof error?.stack === 'string' ? error.stack : null,
    statusCode: Number(error?.statusCode) || null,
  };
}

function publish(record, forceFull = false) {
  if (!record || record.disposed) return;
  const source = record.runtime.getState?.() || {};
  const previous = record.publishedSource;
  if (!forceFull && source === previous) return;
  const body = forceFull || !previous
    ? { full: sanitizeForWire(source) }
    : { patch: sanitizeForWire(diffSessionState(previous, source)) };
  record.publishedSource = source;
  record.revision += 1;
  send({
    type: 'state',
    runtimeId: record.id,
    revision: record.revision,
    ...body,
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
    publishedSource: null,
    revision: 0,
  };
  records.set(record.id, record);
  record.unsubscribe = runtime.subscribe?.(() => publish(record)) ?? null;
  publish(record, true);
  // Session turns run providers in this shard too: their cooldowns must reach
  // sibling shards on the event, not on the next telemetry tick.
  ensureProviderCooldownBridge();
  return { created: true };
}

async function callRuntime(message) {
  const record = records.get(message.runtimeId);
  if (!record || record.disposed) throw new Error(`session runtime ${message.runtimeId} is unavailable`);
  const method = String(message.method || '');
  const target = record.runtime?.[method];
  if (typeof target !== 'function') throw new TypeError(`session action ${method} is unavailable`);
  if (method === 'dispose') {
    const value = await disposeSessionRuntimeRecord(records, record, message.args);
    return sanitizeForWire(value);
  }
  const value = await target.apply(record.runtime, Array.isArray(message.args) ? message.args : []);
  publish(record);
  // Cheap synchronous check: a fast-mode cooldown that the admission scheduler
  // never saw (long provider window) still leaves at the first call boundary.
  publishProviderCooldownNow();
  return sanitizeForWire(value);
}

// ── Memory-cycle agent dispatch ────────────────────────────────────────────
// Cycle agents (LLM maintenance calls brokered by the daemon) execute in THIS
// worker: the daemon process is permanent and allocator churn there is
// unreclaimable, while this worker already recycles above its RSS threshold
// once fully idle. The orchestrator graph and providers load lazily on the
// first dispatch; an in-flight dispatch holds an 'agent' admission lease, so
// the host's recycle guard (activeResources) never interrupts one.
let agentGraphPromise = null;
function loadAgentGraph() {
  const testModule = process.env.NODE_ENV === 'test'
    ? String(process.env.MIXDOG_SESSION_RUNTIME_TEST_AGENT_GRAPH || '')
    : '';
  if (testModule) {
    return import(testModule).then((module) => module.default || module);
  }
  return Promise.all([
    import('../runtime/agent/orchestrator/config.mjs'),
    import('../runtime/agent/orchestrator/providers/registry.mjs'),
    import('../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs'),
  ]).then(([config, registry, dispatch]) => ({ config, registry, dispatch }));
}

function agentGraph() {
  agentGraphPromise ??= loadAgentGraph().catch((error) => {
      agentGraphPromise = null;
      throw error;
    });
  return agentGraphPromise;
}
const agentDispatchers = new Map();
const agentDispatchRuns = new Map(); // dispatchId -> AbortController

async function deliverDistributedAgentNotification(message) {
  const ownerSessionId = String(message.ownerSessionId || '');
  if (!ownerSessionId || !message.text) return false;
  for (const record of records.values()) {
    if (record.disposed) continue;
    try {
      if (record.runtime?.deliverToolCompletion?.(
        ownerSessionId,
        String(message.text),
        message.meta || {},
      )) return true;
    } catch {}
  }
  // The owning runtime may be between recycle and recreate. Persist the
  // completion in its ordinary pending queue so the resumed session still
  // consumes it exactly once.
  try {
    const [mgr, contract] = await Promise.all([
      import('../runtime/agent/orchestrator/session/manager.mjs'),
      import('../runtime/shared/tool-execution-contract.mjs'),
    ]);
    const visible = contract.modelVisibleToolCompletionMessage(
      String(message.text),
      message.meta || {},
    );
    return Boolean(visible && mgr.enqueuePendingMessage(
      ownerSessionId,
      mgr.markCompletionEntry(visible, {
        executionId: message.meta?.execution_id,
      }),
    ) > 0);
  } catch {
    return false;
  }
}
// A cancel can arrive while a dispatch is still in its COLD-START window
// (orchestrator import + provider init) or even before its own request frame is
// handled. Answering "not running" there would drop the abort and let the
// dispatch run anyway, so the cancellation is retained and adopted the moment
// the dispatch registers.
const retainedDispatchCancels = new Map(); // dispatchId -> { reason, at }
const RETAINED_CANCEL_MAX = 256;
const RETAINED_CANCEL_TTL_MS = 5 * 60_000;

function retainDispatchCancel(dispatchId, reason) {
  retainedDispatchCancels.delete(dispatchId);
  retainedDispatchCancels.set(dispatchId, { reason, at: Date.now() });
  while (retainedDispatchCancels.size > RETAINED_CANCEL_MAX) {
    const oldest = retainedDispatchCancels.keys().next().value;
    if (oldest === undefined) break;
    retainedDispatchCancels.delete(oldest);
  }
}

function takeRetainedDispatchCancel(dispatchId) {
  const entry = retainedDispatchCancels.get(dispatchId);
  if (!entry) return null;
  retainedDispatchCancels.delete(dispatchId);
  // A stale tombstone must never abort an unrelated later dispatch.
  if (Date.now() - entry.at > RETAINED_CANCEL_TTL_MS) return null;
  return entry.reason;
}

function abortDispatchController(controller, reason) {
  try { controller.abort(reason); } catch { try { controller.abort(); } catch { /* settled */ } }
}

function throwIfDispatchAborted(controller) {
  if (!controller.signal.aborted) return;
  const reason = controller.signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason || 'agent dispatch canceled'));
}
let preparedProviderSignature = null;
let providerPreparePromise = null;

async function prepareAgentProviders() {
  const { config, registry } = await agentGraph();
  const providers = config.loadConfig()?.providers || {};
  let signature = null;
  try { signature = JSON.stringify(providers); } catch { /* re-prepare each call */ }
  if (signature !== null && preparedProviderSignature === signature) return;
  if (providerPreparePromise) {
    await providerPreparePromise;
    if (signature !== null && preparedProviderSignature === signature) return;
    return prepareAgentProviders();
  }
  const pending = Promise.resolve()
    .then(() => registry.initProviders(providers))
    .then(() => { preparedProviderSignature = signature; });
  const tracked = pending.finally(() => {
    if (providerPreparePromise === tracked) providerPreparePromise = null;
  });
  providerPreparePromise = tracked;
  await tracked;
}

async function runAgentDispatch(message) {
  const dispatchId = String(message.dispatchId || '');
  if (!dispatchId) throw new Error('agent dispatch id is required');
  if (agentDispatchRuns.has(dispatchId)) {
    throw new Error(`agent dispatch ${dispatchId} is already running`);
  }
  // Registration happens BEFORE the first await. The cold-start window (module
  // graph import + provider init) is exactly when a user abort arrives, and an
  // unregistered dispatch would answer cancelled:false and then run anyway.
  const controller = new AbortController();
  agentDispatchRuns.set(dispatchId, controller);
  const retained = takeRetainedDispatchCancel(dispatchId);
  if (retained) abortDispatchController(controller, retained);
  try {
    throwIfDispatchAborted(controller);
    const agent = String(message.agent || '');
    const { dispatch } = await agentGraph();
    throwIfDispatchAborted(controller);
    await prepareAgentProviders();
    throwIfDispatchAborted(controller);
    ensureProviderCooldownBridge();
    let dispatcher = agentDispatchers.get(agent);
    if (!dispatcher) {
      dispatcher = dispatch.makeAgentDispatch({
        agent,
        ...(message.options && typeof message.options === 'object' ? message.options : {}),
      });
      agentDispatchers.set(agent, dispatcher);
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const prompt = String(params.prompt ?? '');
    const value = await dispatcher({
      prompt,
      preset: params.preset || undefined,
      cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined,
      parentSignal: controller.signal,
      ...(Number.isFinite(Number(params.idleTimeoutMs)) && Number(params.idleTimeoutMs) > 0
        ? { idleTimeoutMs: Number(params.idleTimeoutMs) }
        : {}),
    });
    return { value: sanitizeForWire(value) ?? null };
  } finally {
    agentDispatchRuns.delete(dispatchId);
    publishProviderCooldownNow();
  }
}

function cancelAgentDispatch(message) {
  const dispatchId = String(message.dispatchId || '');
  const reason = new Error(String(message.reason || 'agent dispatch canceled'));
  const controller = agentDispatchRuns.get(dispatchId);
  if (controller) {
    abortDispatchController(controller, reason);
    return { cancelled: true, retained: false };
  }
  if (!dispatchId) return { cancelled: false, retained: false };
  // Not registered yet: retain the cancellation instead of losing it. The
  // dispatch adopts it at registration, so a cold-start abort can never be
  // answered "not running" and then keep running.
  retainDispatchCancel(dispatchId, reason);
  return { cancelled: true, retained: true };
}

async function prewarm() {
  const module = await sessionModule();
  await Promise.allSettled([
    () => module.preloadSessionRuntimeModule?.(),
    () => module.preloadAgentLoopRuntime?.(),
    () => module.preloadKeychainSecrets?.(),
    () => module.preloadMemoryRuntime?.(),
  ].map((start) => Promise.resolve().then(start)));
  return { ready: true };
}

/** Runtime-worker workload telemetry for the daemon status panel. Gate modules
 *  are already resident once any tool has run; loading them here otherwise is
 *  cheap and side-effect-free. */
async function workloadSnapshot() {
  const [gate, workload, resources] = await Promise.all([
    import('../runtime/shared/child-spawn-gate.mjs'),
    import('../runtime/shared/tool-workload-gates.mjs'),
    import('../runtime/shared/resource-admission.mjs'),
  ]);
  const memory = process.memoryUsage();
  return {
    shard: SHARD_INDEX,
    eventLoopLag: lastLagSample,
    runtimes: records.size,
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBufferBytes: memory.arrayBuffers,
    },
    childSpawns: gate.snapshot(),
    toolIo: workload.toolWorkloadSnapshot(),
    resources: resources.resourceAdmission.snapshot(),
  };
}

// Accepted user input lives in the pending-message spool until its write
// settles. Exiting on top of an in-flight write silently loses it, so every
// exit path drains the spool first (bounded; a stuck write must not wedge
// shutdown).
async function exitAfterPendingWrites(code = 0) {
  try {
    const pendingMessages = await import(
      '../runtime/agent/orchestrator/session/manager/pending-messages.mjs'
    );
    await pendingMessages.settlePendingMessageWrites?.({ timeoutMs: 1_500 });
  } catch (error) {
    try {
      process.stderr.write(
        `[session-runtime-worker] pending message drain failed: ${error?.message || error}\n`,
      );
    } catch {}
  }
  process.exit(code);
}

async function stopAll(reason = 'session runtime worker shutdown') {
  if (stopping) return;
  stopping = true;
  try { stopEventLoopLagMonitor(); } catch {}
  try { cooldownBridgeUnsubscribe?.(); } catch {}
  cooldownBridgeUnsubscribe = null;
  retainedDispatchCancels.clear();
  for (const controller of agentDispatchRuns.values()) {
    try { controller.abort(new Error(reason)); } catch { /* settled */ }
  }
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
  // Backstop for sessions whose runtime never reached a clean dispose: the host
  // keeps their workers and target claims until it is told to release them.
  try { await releaseAllComputerSessions(); } catch { /* best-effort shutdown */ }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'agent-control-result') return;
  // Fire-and-forget shard coordination: no response frame, no request id.
  if (message.type === 'provider-cooldown-sync') {
    void applyReplayedProviderCooldown(message);
    return;
  }
  if (message.type === 'agent-control-notification') {
    void deliverDistributedAgentNotification(message);
    return;
  }
  const requestId = String(message.requestId || '');
  void (async () => {
    if (message.type === 'create') return createRuntime(message);
    if (message.type === 'call') return callRuntime(message);
    if (message.type === 'snapshot') {
      const record = records.get(message.runtimeId);
      if (!record) throw new Error(`session runtime ${message.runtimeId} is unavailable`);
      publish(record, true);
      return { published: true };
    }
    if (message.type === 'prewarm') return prewarm();
    if (message.type === 'workload') return workloadSnapshot();
    if (message.type === 'agent-dispatch') return runAgentDispatch(message);
    if (message.type === 'agent-dispatch-cancel') return cancelAgentDispatch(message);
    if (message.type === 'shutdown') {
      await stopAll(message.reason);
      return { stopped: true };
    }
    throw new Error(`unknown session runtime message ${message.type}`);
  })().then((value) => {
    if (requestId) send({ type: 'response', requestId, ok: true, value: value ?? null });
    reportUnhealthy();
    if (message.type === 'shutdown') setImmediate(() => { void exitAfterPendingWrites(0); });
  }).catch((error) => {
    if (requestId) send({ type: 'response', requestId, ok: false, error: errorBody(error) });
    reportUnhealthy();
  });
});

process.on('disconnect', () => {
  void stopAll('session runtime parent disconnected')
    .finally(() => exitAfterPendingWrites(0));
});

process.on('SIGTERM', () => {
  void stopAll('session runtime SIGTERM').finally(() => exitAfterPendingWrites(0));
});
