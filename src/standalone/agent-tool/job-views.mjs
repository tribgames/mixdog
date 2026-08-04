// Job/session view layer, extracted from agent-tool.mjs: busy checks, the
// /agents list projection, per-session progress extras, job snapshots and
// lookup (including worker fallback), render shaping, and spawn-meta
// builders. Pure readers over the tag registry + job stores.
import { ACTIVE_STAGES } from './tool-def.mjs';
import { createProviderInit } from './provider-init.mjs';
import { resolveAgentWatchdogPolicy } from '../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { buildAgentTaskProgressFields } from '../agent-task-status.mjs';
import { clean, normalizeAgentName, positiveInt, presetKey, terminalPidForContext } from './helpers.mjs';
import { getBackgroundTask, listBackgroundTasks, sanitizeTaskMeta, taskIdFromArgs } from '../../runtime/shared/background-tasks.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';
import { isTerminalWorkerStatus } from './worker-rows.mjs';

// Job statuses that can never progress again (mirrors TERMINAL_STATUSES in
// runtime/shared/background-tasks.mjs; 'canceled' accepted defensively).
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

// A finished job is frozen history. Tags are reused, so its meta.sessionId can
// point at a session that is NOW running a *different* job; reading live
// progress for it made every old completed row inherit the current worker's
// stage ("20 completed rows all reporting streaming/model active"). Terminal
// rows therefore report only their own recorded status: no live worker
// snapshot, no silent_for/watchdog/queued_followups.
export function terminalJobFrozenFields(status, now = Date.now()) {
  const stage = String(status ?? '').trim().toLowerCase() || 'unknown';
  return {
    workerStatus: stage,
    stage,
    clientHostPid: null,
    lastStreamDeltaAt: null,
    ...buildAgentTaskProgressFields({ now, runtimeStage: stage, taskStatus: stage }),
  };
}

// Default /agents worker section = workers that can still do work. Idle,
// closed, errored and reaped/unknown rows are history and stay reachable
// through the task section (status/read keep their terminal result).
export function isActiveWorkerRow(row = {}) {
  const stage = String(row.stage ?? '').trim().toLowerCase();
  const status = String(row.status ?? '').trim().toLowerCase();
  if (ACTIVE_STAGES.has(stage) || ACTIVE_STAGES.has(status)) return true;
  const effective = stage || status;
  if (!effective || effective === 'unknown') return false;
  return !isTerminalWorkerStatus(effective);
}

export function createJobViews({
  mgr,
  getLiveSession,
  reg,
  DEFAULT_SPAWN_PREP_TIMEOUT_MS,
  refreshTagsFromSessions,
  agentSessionEntries,
  tags,
  cfgMod,
}) {
  function isSessionBusy(sessionId) {
    const runtime = mgr.getSessionRuntime?.(sessionId);
    if (runtime?.controller?.signal && !runtime.controller.signal.aborted) return true;
    if (runtime?.stage) return ACTIVE_STAGES.has(runtime.stage);
    const session = getLiveSession(sessionId);
    return ACTIVE_STAGES.has(session?.status || '');
  }

  // Provider init de-dup lives in ./agent-tool/provider-init.mjs; the factory
  // keeps its per-provider chain/ready state private per agent instance. The
  // chain-gate defaults to the spawn-prep cap (see provider-init.mjs comments).
  const { ensureProvider } = createProviderInit(reg, DEFAULT_SPAWN_PREP_TIMEOUT_MS);

  function list({ scanSessions = false, context = {}, includeTerminal = false } = {}) {
    refreshTagsFromSessions({ scanSessions, context });
    const now = Date.now();
    const rows = [];
    for (const { tag, session } of agentSessionEntries({ scanSessions, context })) {
      const sessionId = session.id;
      const runtime = mgr.getSessionRuntime?.(sessionId);
      const status = session.closed === true ? 'closed' : (session.status || 'idle');
      const stage = session.stage || (status === 'idle' || status === 'error' || status === 'closed'
        ? status
        : (runtime?.stage || status));
      const progress = sessionProgressExtras(sessionId, session.agent || null, now);
      rows.push({
        tag,
        sessionId,
        agent: session.agent || null,
        provider: session.provider,
        model: session.model,
        preset: session.presetName || null,
        effort: session.effort || null,
        fast: session.fast === true,
        status,
        stage,
        ...progress,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        lastUsedAt: session.lastUsedAt || null,
        clientHostPid: session.clientHostPid || null,
        lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
        staleSeconds: runtime?.lastStreamDeltaAt ? Math.floor((now - runtime.lastStreamDeltaAt) / 1000) : null,
        windowTokens: Number(session.lastContextTokens ?? session.lastInputTokens) || 0,
        windowCap: Number(session.contextWindow) || null,
        permission: session.permission || null,
        toolPermission: session.toolPermission || null,
        messages: Array.isArray(session.messages) ? session.messages.length : Math.max(0, Number(session.messageCount || 0)),
        tools: Array.isArray(session.tools) ? session.tools.length : Math.max(0, Number(session.toolCount || 0)),
      });
    }
    return includeTerminal ? rows : rows.filter((row) => isActiveWorkerRow(row));
  }

  function sessionProgressExtras(sessionId, role, now = Date.now(), taskStatus = null) {
    if (!sessionId) return {};
    const session = mgr.getSession(sessionId);
    const runtime = mgr.getSessionRuntime?.(sessionId) || null;
    const snapshot = typeof mgr.getSessionProgressSnapshot === 'function'
      ? mgr.getSessionProgressSnapshot(sessionId)
      : null;
    const policy = role ? resolveAgentWatchdogPolicy(role) : null;
    const queuedFollowups = typeof mgr.getSessionPendingMessageDepth === 'function'
      ? mgr.getSessionPendingMessageDepth(sessionId)
      : null;
    return buildAgentTaskProgressFields({
      now,
      sessionStatus: session?.status || null,
      runtimeStage: runtime?.stage || snapshot?.stage || session?.status || null,
      snapshot,
      runtime,
      policy,
      queuedFollowups,
      taskStatus,
      lastToolCall: runtime?.lastToolCall || null,
    });
  }

  function jobWorkerSnapshot(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    if (!session) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = session.closed === true ? 'closed' : (session.status || 'idle');
    const progress = sessionProgressExtras(sessionId, session.agent || null);
    return {
      workerStatus: status,
      stage: progress.worker_stage || runtime?.stage || status,
      clientHostPid: session.clientHostPid || null,
      lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
      ...progress,
    };
  }

  function listJobs(context = {}) {
    const wantedPid = terminalPidForContext(context);
    const now = Date.now();
    const rows = listBackgroundTasks({ surface: 'agent', context }).map((task) => {
      const head = {
        task_id: task.task_id,
        type: task.operation,
        status: task.status,
        tag: task.tag || null,
        sessionId: task.sessionId || null,
        agent: task.agent || null,
        preset: task.preset || null,
        provider: task.provider || null,
        model: task.model || null,
        effort: task.effort || null,
        fast: task.fast === true || task.fast === false ? task.fast : null,
        maxLoopIterations: task.maxLoopIterations || null,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt || null,
        error: task.error || null,
      };
      if (isTerminalJobStatus(task.status)) return { ...head, ...terminalJobFrozenFields(task.status, now) };
      return {
        ...head,
        ...jobWorkerSnapshot(task.sessionId),
        ...sessionProgressExtras(task.sessionId, task.agent || null, now, task.status),
      };
    });
    return wantedPid
      ? rows.filter((row) => {
        const pid = positiveInt(row.clientHostPid);
        // Spawn-prep rows have no worker session (and therefore no pid) yet;
        // they already passed taskMatchesScope, so the queued spawn stays
        // visible instead of vanishing until a pool slot frees up (user bug:
        // "spawned 5, only 4 listed").
        return pid ? pid === wantedPid : true;
      })
      : rows;
  }

  function getJob(args, context = {}) {
    const taskId = taskIdFromArgs(args);
    if (taskId) {
      const task = getBackgroundTask(taskId, { surface: 'agent', context });
      if (!task) throw new Error(`agent read/status: task "${taskId}" not found`);
      return task;
    }
    // Fall back to tag/sessionId resolution, same precedence as close()
    // (agent-tool.mjs close()): clean(args.tag || args.sessionId || ...).
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent read/status: task_id, tag, or sessionId is required');
    const candidates = listBackgroundTasks({ surface: 'agent', context })
      .filter(Boolean)
      .filter((row) => row.tag === target || row.sessionId === target);
    if (!candidates.length) throw new Error(`agent read/status: no task found for tag/sessionId "${target}"`);
    // Prefer most recent when multiple tasks match the same tag.
    candidates.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
    const task = getBackgroundTask(candidates[0].task_id, { surface: 'agent', context });
    if (!task) throw new Error(`agent read/status: task "${candidates[0].task_id}" not found`);
    return task;
  }

  // Background tasks are process-memory only; a worker SESSION can outlive
  // its spawn task (task pruned, engine restarted). read/status by tag then
  // used to throw "no task found" even though the worker exists. Fall back to
  // a synthetic job view built from the worker session, with the last
  // assistant message as the readable result.
  function workerFallbackJob(target, context = {}) {
    refreshTagsFromSessions({ scanSessions: true, context });
    const sessionId = tags.get(target) || (mgr.getSession(target) ? target : null);
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    if (!session) return null;
    const status = session.closed === true ? 'closed' : (session.status || 'idle');
    const msgs = Array.isArray(session.messages) ? session.messages : [];
    const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant'
      && (typeof m.content === 'string' ? m.content.trim() : m.content));
    const resultText = lastAssistant
      ? (typeof lastAssistant.content === 'string' ? lastAssistant.content : JSON.stringify(lastAssistant.content))
      : '(worker session has no assistant output yet)';
    return {
      taskId: null,
      operation: 'worker',
      status,
      startedAt: session.createdAt || null,
      finishedAt: null,
      error: null,
      result: resultText,
      meta: {
        tag: tags.has(target) ? target : (session.tag || null),
        sessionId,
        agent: session.agent || null,
        preset: session.presetName || null,
        provider: session.provider || null,
        model: session.model || null,
        effort: session.effort || null,
        fast: session.fast === true,
        maxLoopIterations: null,
      },
    };
  }

  function getJobOrWorker(args, context = {}) {
    try {
      return getJob(args, context);
    } catch (error) {
      const target = clean(args.tag || args.sessionId);
      const fallback = target ? workerFallbackJob(target, context) : null;
      if (fallback) return fallback;
      throw error;
    }
  }

  function renderJob(job, includeResult = false) {
    const meta = job.meta || {};
    const head = {
      task_id: job.taskId,
      type: job.operation,
      status: job.status,
      tag: meta.tag || null,
      sessionId: meta.sessionId || null,
      agent: meta.agent || null,
      ...(meta.respawned === true ? { respawned: true, note: 'previous session reaped — fresh session, no prior context; re-supply anchors if needed' } : {}),
      preset: meta.preset || null,
      provider: meta.provider || null,
      model: meta.model || null,
      effort: meta.effort || null,
      fast: meta.fast === true || meta.fast === false ? meta.fast : null,
      maxLoopIterations: meta.maxLoopIterations || null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
    };
    const tail = includeResult && job.result !== undefined ? { result: job.result } : {};
    // Frozen terminal view: never re-read the (possibly reused) live session.
    if (isTerminalJobStatus(job.status)) {
      return { ...head, ...terminalJobFrozenFields(job.status), ...tail };
    }
    let progress = sessionProgressExtras(meta.sessionId, meta.agent || null, Date.now(), job.status);
    // Spawn is deferred: before the worker session exists, sessionProgressExtras
    // returns {} and the status card would show only "status: running" with no
    // stage/progress. Fill a minimal stage so the caller can tell the job is
    // still spinning up rather than silently stalled.
    if (!meta.sessionId && (!progress || Object.keys(progress).length === 0)) {
      const spawning = job.status === 'running';
      progress = {
        worker_stage: spawning ? 'spawning' : (job.status || 'unknown'),
        last_progress: spawning ? 'spawning worker session' : (job.status || 'unknown'),
        diagnostic: spawning ? 'worker session not started yet' : (job.status || 'unknown'),
      };
    }
    return {
      ...head,
      ...jobWorkerSnapshot(meta.sessionId),
      ...progress,
      ...tail,
    };
  }

  function preparedSpawnMeta(prepared, extras = {}) {
    return sanitizeTaskMeta({
      ...(extras || {}),
      tag: prepared.tag,
      sessionId: prepared.session.id,
      agent: prepared.agent,
      preset: presetKey(prepared.preset) || prepared.presetName,
      provider: prepared.preset.provider,
      model: prepared.preset.model,
      effort: prepared.preset.effort || null,
      fast: prepared.preset.fast === true,
      maxLoopIterations: prepared.maxLoopIterations || null,
    });
  }

  function pendingSpawnMeta(args = {}, extras = {}) {
    const agent = normalizeAgentName(args.agent);
    // Best-effort resolve the default preset so the pending "Spawn …" card can
    // already show the model (e.g. "Spawn Heavy Worker (Opus 4.8)") even when
    // the caller did not pass an explicit provider/model. Never throw: fall back
    // to whatever raw args carry.
    let resolved = null;
    if (!clean(args.model) || !clean(args.provider)) {
      try { resolved = resolveAgentSpawnPreset(cfgMod.loadConfig(), args)?.preset || null; }
      catch { resolved = null; }
    }
    return sanitizeTaskMeta({
      ...(extras || {}),
      tag: clean(args.tag) || null,
      sessionId: null,
      agent: agent || null,
      preset: clean(args.preset) || presetKey(resolved) || null,
      provider: clean(args.provider) || clean(resolved?.provider) || null,
      model: clean(args.model) || clean(resolved?.model) || null,
      effort: clean(args.effort) || clean(resolved?.effort) || null,
      fast: args.fast === true ? true : (resolved?.fast === true ? true : null),
    });
  }

  function mergeJobMeta(job, meta = {}) {
    if (!job || !meta || typeof meta !== 'object') return;
    const next = sanitizeTaskMeta({ ...(job.meta || {}), ...meta });
    job.meta = next;
    if (job.input && typeof job.input === 'object') {
      job.input = {
        ...job.input,
        tag: next.tag || job.input.tag || null,
        sessionId: next.sessionId || job.input.sessionId || null,
        agent: next.agent || job.input.agent || null,
      };
    }
    job.label = next.tag || next.sessionId || job.label;
  }

  return {
    isSessionBusy,
    ensureProvider,
    list,
    sessionProgressExtras,
    jobWorkerSnapshot,
    listJobs,
    getJob,
    workerFallbackJob,
    getJobOrWorker,
    renderJob,
    preparedSpawnMeta,
    pendingSpawnMeta,
    mergeJobMeta,
  };
}
