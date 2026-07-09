import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  reconcileBackgroundTask,
  startBackgroundTask,
  sanitizeTaskMeta,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { presentErrorText, errorLine } from '../runtime/shared/err-text.mjs';
import { updateJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import { normalizeAgentPermission } from '../runtime/shared/markdown-frontmatter.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';
import { prepareAgentSession } from '../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import {
  abortAgentProgressWatchdog,
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  resolveAgentWatchdogPolicy,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
  AgentStallAbortError,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { buildAgentTaskProgressFields } from './agent-task-status.mjs';
import { AGENT_OWNER } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { isKnownProvider } from './provider-admin.mjs';
import {
  ACTIVE_STAGES,
  AGENT_TOOL,
  DEFAULT_AGENT_PRESETS,
  DEFAULT_PROVIDER,
  WORKER_INDEX_FILE,
} from './agent-tool/tool-def.mjs';
import {
  agentPresetName,
  agentScope,
  agentTagOf,
  clean,
  clearAgentStatuslineRoute,
  envTimeoutMs,
  findPreset,
  nonNegativeInt,
  normalizeAgentName,
  normalizeAgentRoute,
  positiveInt,
  presetKey,
  readAgentFrontmatterPermission,
  resolvePrompt,
  rowMatchesContext,
  sessionMatchesContext,
  synthesizePreset,
  terminalPidForContext,
  withCwdHeader,
  writeAgentStatuslineRoute,
} from './agent-tool/helpers.mjs';
import { abnormalEmptyFinishError, renderResult } from './agent-tool/render.mjs';
import { createProviderInit } from './agent-tool/provider-init.mjs';
import { createNotify } from './agent-tool/notify.mjs';
// Re-export the static tool descriptor so importers of this facade keep the
// identical public surface (`import { AGENT_TOOL } from './agent-tool.mjs'`).
export { AGENT_TOOL };

ensureProcessListenerHeadroom(64);

const STANDALONE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Grace window during which a terminated/idle worker row is kept around so the
// same terminal can re-use (or cleanly re-spawn) the same tag. Cached as a
// constant like the other timeouts; override with MIXDOG_AGENT_TERMINAL_REAP_MS.
// 5m (was 1h): aligned with the BP4 message-tail cache TTL — past 5m the
// session's prompt cache is cold anyway, so same-tag reuse pays a full prefix
// rewrite; a fresh respawn (send dead-tag fallback) starts smaller and cheaper.
// Trace replay (2026-07): agent tail cost 1h 1.77M -> 5m 1.11M (-37%).
const TERMINAL_REAP_MS = envTimeoutMs('MIXDOG_AGENT_TERMINAL_REAP_MS', 5 * 60_000);
// Provider-aware reap windows: the 5m default matches Anthropic's 5m agent
// tail TTL, but providers with long-lived automatic prefix caches (OpenAI 24h
// retention, DeepSeek hours-days, Groq 2h) keep a warm cache well past 5m, so
// same-tag reuse stays cheaper than a respawn. Capped at 1h — holding closed
// worker sessions longer hoards manager memory for a reuse pattern that
// rarely spans hours. Explicit MIXDOG_AGENT_TERMINAL_REAP_MS overrides all.
const PROVIDER_REAP_MS = {
  'openai': 60 * 60_000,
  'deepseek': 60 * 60_000,
  'groq': 60 * 60_000,
  'openai-oauth': 10 * 60_000,
};
function reapMsForProvider(provider) {
  if (clean(process.env.MIXDOG_AGENT_TERMINAL_REAP_MS)) return TERMINAL_REAP_MS;
  return PROVIDER_REAP_MS[clean(provider)] || TERMINAL_REAP_MS;
}
// Independent hard cap for the spawn *prep* phase (ensureProvider /
// prepareAgentSession / catalog+rules load). Kept separate from the
// first-response watchdog so prep cannot hang a whole fanout before the model
// request starts. Set MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS=0 to fully disable the
// cap and restore strictly-unbounded prep.
const DEFAULT_SPAWN_PREP_TIMEOUT_MS = envTimeoutMs('MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS', 120_000);

// Global spawn-start stagger: unlimited-N parallel fan-out otherwise fires all
// first provider calls in the same instant, racing the server-side prompt-
// cache write/propagation window. Default 0 (off): mirrors the explore fan-out
// finding — the first spawn's prompt-cache write only lands after its iter1
// completes (~seconds), so a sub-second stagger yields ~no cross-spawn cache
// reads while charging every later spawn the full delay, i.e. pure fan-out
// latency for negligible hit-rate gain. Kept as a knob for tuning: set
// MIXDOG_SPAWN_STAGGER_MS>0 to re-enable. When >0 it chains (not a fixed lane
// count) so it scales to any N: each new spawn's start is pushed to at least
// STAGGER_MS after the previous spawn's start; sequential/non-overlapping
// spawns pay zero added latency. Applied inside the deferred job body (see
// startDeferredSpawnJob) so the agent tool call itself still returns task_id
// immediately.
const SPAWN_STAGGER_MS = envTimeoutMs('MIXDOG_SPAWN_STAGGER_MS', 0);
let lastSpawnStartAt = 0;
async function waitForSpawnStagger() {
  if (SPAWN_STAGGER_MS <= 0) return;
  const now = Date.now();
  const myStart = Math.max(now, lastSpawnStartAt + SPAWN_STAGGER_MS);
  lastSpawnStartAt = myStart;
  const delay = myStart - now;
  if (delay <= 0) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, delay);
    t.unref?.();
  });
}

export function createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: defaultCwd, onSubagentEvent }) {
  // Optional bridge to the standard hook bus for SubagentStart / SubagentStop.
  // Best-effort: a hook error must never affect worker spawn/finish.
  function emitSubagentEvent(phase, agent, extra = {}) {
    if (typeof onSubagentEvent !== 'function') return;
    try { onSubagentEvent(phase, { agent_type: agent || null, ...extra }); } catch { /* best-effort */ }
  }
  const tags = new Map();
  const tagAgents = new Map();
  const tagCwds = new Map();
  const reapTimers = new Map();
  const workerIndexMutators = [];
  let workerIndexFlushTimer = null;
  function workerIndexPath() {
    return dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  }

  function workerRowKey(row = {}) {
    return clean(row.sessionId) || clean(row.tag);
  }

  function workerRowTime(row = {}) {
    return Date.parse(row.updatedAt || row.finishedAt || row.lastUsedAt || row.createdAt || '') || 0;
  }

  function isTerminalWorkerStatus(status) {
    return /^(idle|closed|completed|failed|error|cancelled|canceled|killed|timeout)$/i.test(clean(status));
  }

  function keepWorkerRow(row = {}) {
    if (!clean(row.tag) || !clean(row.sessionId)) return false;
    const t = workerRowTime(row);
    if (!t) return true;
    if (!isTerminalWorkerStatus(row.status || row.stage)) return true;
    return Date.now() - t < reapMsForProvider(row.provider);
  }

  function normalizeWorkerRows(value) {
    const source = Array.isArray(value?.workers)
      ? value.workers
      : (value?.workers && typeof value.workers === 'object'
        ? Object.values(value.workers)
        : (Array.isArray(value) ? value : []));
    return source
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        tag: clean(row.tag),
        sessionId: clean(row.sessionId),
        agent: clean(row.agent) || null,
        provider: clean(row.provider) || null,
        model: clean(row.model) || null,
        preset: clean(row.preset) || null,
        effort: clean(row.effort) || null,
        fast: row.fast === true ? true : (row.fast === false ? false : null),
        status: clean(row.status) || 'idle',
        stage: clean(row.stage) || clean(row.status) || 'idle',
        createdAt: clean(row.createdAt) || null,
        updatedAt: clean(row.updatedAt) || null,
        lastUsedAt: clean(row.lastUsedAt) || null,
        finishedAt: clean(row.finishedAt) || null,
        clientHostPid: positiveInt(row.clientHostPid),
        cwd: clean(row.cwd) || null,
        task_id: clean(row.task_id || row.taskId) || null,
        error: clean(row.error) || null,
        permission: clean(row.permission) || null,
        toolPermission: clean(row.toolPermission) || null,
        messages: positiveInt(row.messages) || 0,
        tools: positiveInt(row.tools) || 0,
      }))
      .filter(keepWorkerRow);
  }

  // Mtime-keyed parse cache for the worker index. A single spawn calls
  // refreshTagsFromSessions()/resolveTag()/nextTag() which each re-read and
  // re-JSON.parse this file; across a parallel fanout that is O(spawns^2)
  // synchronous reads of the same bytes on the event loop. Cache the parsed,
  // normalized rows and reuse them while the file mtime+size is unchanged.
  // Writes bump _workerRowsCacheDirty so the very next read re-parses.
  let _workerRowsCache = null; // { mtimeMs, size, rows }
  let _workerRowsCacheDirty = true;
  function invalidateWorkerRowsCache() {
    _workerRowsCacheDirty = true;
  }
  function readAllWorkerRows() {
    const file = workerIndexPath();
    if (!file) return [];
    let st = null;
    try { st = statSync(file); } catch { _workerRowsCache = null; return []; }
    if (!_workerRowsCacheDirty
      && _workerRowsCache
      && _workerRowsCache.mtimeMs === st.mtimeMs
      && _workerRowsCache.size === st.size) {
      return _workerRowsCache.rows;
    }
    let rows = [];
    try {
      rows = normalizeWorkerRows(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      rows = [];
    }
    _workerRowsCache = { mtimeMs: st.mtimeMs, size: st.size, rows };
    _workerRowsCacheDirty = false;
    return rows;
  }
  function readWorkerRows(context = {}) {
    const rows = readAllWorkerRows();
    if (rows.length === 0) return rows;
    return rows.filter((row) => rowMatchesContext(row, context));
  }

  function workerRowsForUpdate(cur) {
    return normalizeWorkerRows(cur);
  }

  function writeWorkerRows(mutator) {
    const file = workerIndexPath();
    if (!file || typeof mutator !== 'function') return null;
    try {
      const result = updateJsonAtomicSync(file, (cur) => {
        const byKey = new Map();
        for (const row of workerRowsForUpdate(cur)) {
          const key = workerRowKey(row);
          if (key) byKey.set(key, row);
        }
        mutator(byKey);
        const workers = {};
        for (const row of [...byKey.values()].filter(keepWorkerRow)) {
          const key = workerRowKey(row);
          if (key) workers[key] = row;
        }
        return { version: 1, updatedAt: new Date().toISOString(), workers };
      }, { lock: true });
      // This process just rewrote the index; force the next read to re-parse
      // even if the new mtime/size happen to collide with the cached stat.
      invalidateWorkerRowsCache();
      return result;
    } catch {
      return null;
    }
  }

  function applyWorkerRowUpsert(byKey, normalized) {
    if (!normalized) return;
    const key = workerRowKey(normalized);
    if (!key) return;
    const prev = byKey.get(key) || {};
    const merged = { ...prev, ...normalized };
    for (const field of ['agent', 'provider', 'model', 'preset', 'effort', 'fast', 'clientHostPid', 'cwd', 'task_id', 'permission', 'toolPermission']) {
      if ((merged[field] === null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
        merged[field] = prev[field];
      }
    }
    byKey.set(key, {
      ...merged,
      createdAt: normalized.createdAt || prev.createdAt || new Date().toISOString(),
      updatedAt: normalized.updatedAt || new Date().toISOString(),
    });
  }

  function flushWorkerIndexMutations() {
    if (workerIndexFlushTimer) {
      try { clearImmediate(workerIndexFlushTimer); } catch {}
      workerIndexFlushTimer = null;
    }
    if (workerIndexMutators.length === 0) return;
    const batch = workerIndexMutators.splice(0, workerIndexMutators.length);
    writeWorkerRows((byKey) => {
      for (const mutator of batch) {
        try { mutator(byKey); } catch {}
      }
    });
  }

  function queueWorkerIndexMutation(mutator) {
    if (typeof mutator !== 'function') return false;
    if (!workerIndexPath()) return false;
    workerIndexMutators.push(mutator);
    if (!workerIndexFlushTimer) {
      workerIndexFlushTimer = setImmediate(flushWorkerIndexMutations);
      workerIndexFlushTimer.unref?.();
    }
    return true;
  }

  function workerRowFromSession(session, fallbackTag = '', extra = {}) {
    const tag = agentTagOf(session) || clean(fallbackTag) || clean(extra.tag);
    const sessionId = clean(session?.id || extra.sessionId);
    if (!tag || !sessionId) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = clean(extra.status) || (session?.closed === true ? 'closed' : clean(session?.status) || 'idle');
    const stage = clean(extra.stage) || clean(runtime?.stage) || status;
    const nowIso = new Date().toISOString();
    return {
      tag,
      sessionId,
      agent: clean(extra.agent) || clean(session?.agent) || null,
      provider: clean(extra.provider) || clean(session?.provider) || null,
      model: clean(extra.model) || clean(session?.model) || null,
      preset: clean(extra.preset) || clean(session?.presetName) || null,
      effort: clean(extra.effort) || clean(session?.effort) || null,
      fast: extra.fast === true || extra.fast === false ? extra.fast : (session?.fast === true ? true : null),
      status,
      stage,
      createdAt: clean(session?.createdAt) || clean(extra.createdAt) || nowIso,
      updatedAt: clean(extra.updatedAt) || nowIso,
      lastUsedAt: clean(session?.lastUsedAt) || null,
      finishedAt: clean(extra.finishedAt) || null,
      clientHostPid: positiveInt(extra.clientHostPid) || positiveInt(session?.clientHostPid),
      cwd: clean(session?.cwd) || clean(extra.cwd) || null,
      task_id: clean(extra.task_id || extra.taskId) || null,
      error: clean(extra.error) || null,
      permission: clean(session?.permission) || null,
      toolPermission: clean(session?.toolPermission) || null,
      messages: Array.isArray(session?.messages) ? session.messages.length : 0,
      tools: Array.isArray(session?.tools) ? session.tools.length : 0,
    };
  }

  function workerRowToSession(row = {}) {
    return {
      id: row.sessionId,
      agentTag: row.tag,
      agent: row.agent || null,
      provider: row.provider || null,
      model: row.model || null,
      presetName: row.preset || null,
      effort: row.effort || null,
      fast: row.fast === true,
      status: row.status || 'idle',
      stage: row.stage || row.status || 'idle',
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
      lastUsedAt: row.lastUsedAt || null,
      clientHostPid: row.clientHostPid || null,
      cwd: row.cwd || null,
      permission: row.permission || null,
      toolPermission: row.toolPermission || null,
      messageCount: Math.max(0, Number(row.messages || 0)),
      toolCount: Math.max(0, Number(row.tools || 0)),
    };
  }

  function upsertWorkerRow(row, { defer = false } = {}) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    tags.set(normalized.tag, normalized.sessionId);
    if (normalized.agent) tagAgents.set(normalized.tag, normalized.agent);
    if (normalized.cwd) tagCwds.set(normalized.tag, normalized.cwd);
    if (defer) {
      return queueWorkerIndexMutation((byKey) => applyWorkerRowUpsert(byKey, normalized));
    }
    writeWorkerRows((byKey) => {
      applyWorkerRowUpsert(byKey, normalized);
    });
    return true;
  }

  function upsertWorkerSession(session, fallbackTag = '', extra = {}) {
    return upsertWorkerRow(workerRowFromSession(session, fallbackTag, extra));
  }

  function upsertWorkerSessionDeferred(session, fallbackTag = '', extra = {}) {
    return upsertWorkerRow(workerRowFromSession(session, fallbackTag, extra), { defer: true });
  }

  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
    flushWorkerIndexMutations();
    writeWorkerRows((byKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if ((targetSessionId && row.sessionId === targetSessionId) || (targetTag && row.tag === targetTag)) {
          byKey.delete(key);
        }
      }
    });
  }

  function refreshTagsFromIndex(context = {}) {
    const rows = readWorkerRows(context);
    for (const row of rows) {
      if (!row.tag || !row.sessionId) continue;
      tags.set(row.tag, row.sessionId);
      if (row.agent) tagAgents.set(row.tag, row.agent);
      if (row.cwd) tagCwds.set(row.tag, row.cwd);
    }
    return rows;
  }

  function wantsSessionScan(args = {}) {
    return args.recover === true || args.scanSessions === true || args.scan_sessions === true;
  }

  function resolveTag(target, context = {}, options = {}) {
    const scanSessions = options.scanSessions === true;
    const excludeTerminalTraces = options.excludeTerminalTraces === true;
    refreshTagsFromSessions({ scanSessions, context });
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) {
      const session = getLiveSession(value);
      if (session && sessionMatchesContext(session, context)) return value;
      const row = readWorkerRows(context).find((item) => item.sessionId === value);
      return row ? value : null;
    }
    const matches = agentSessionEntries({ scanSessions, context, excludeTerminalTraces })
      .filter((entry) => entry.tag === value);
    if (matches.length === 1) return matches[0].session.id;
    if (matches.length > 1) {
      throw new Error(`agent: tag "${value}" is ambiguous across terminals; use sessionId`);
    }
    const sessionId = tags.get(value) || null;
    const session = getLiveSession(sessionId);
    return session && sessionMatchesContext(session, context) ? sessionId : null;
  }

  function getLiveSession(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    return session && session.closed !== true ? session : null;
  }

  function tagForSession(sessionId) {
    const session = getLiveSession(sessionId);
    const persistedTag = agentTagOf(session);
    if (persistedTag) return persistedTag;
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  function agentSessionEntries({ scanSessions = false, context = {}, excludeTerminalTraces = false } = {}) {
    const rows = [];
    const seen = new Set();
    const add = (session, fallbackTag = '') => {
      const tag = agentTagOf(session) || clean(fallbackTag);
      if (!tag || !session?.id || session.closed === true) return;
      if (!sessionMatchesContext(session, context)) return;
      if (seen.has(session.id)) return;
      seen.add(session.id);
      rows.push({ tag, session });
    };
    const addIndexRow = (row) => {
      const tag = clean(row?.tag);
      const sessionId = clean(row?.sessionId);
      if (!tag || !sessionId || !rowMatchesContext(row, context)) return;
      if (seen.has(sessionId)) return;
      // Collision/resolution enumeration only: a row that is in a terminal
      // (or idle-but-finished) state AND has no live session behind it is a
      // lingering trace kept for the reap grace window. excludeTerminalTraces drops those
      // rows so live-session reuse/spawn resolution can proceed; list/status
      // keep excludeTerminalTraces=false so finished workers still appear.
      if (excludeTerminalTraces
        && isTerminalWorkerStatus(row.status || row.stage)
        && !getLiveSession(sessionId)) {
        return;
      }
      seen.add(sessionId);
      rows.push({ tag, session: workerRowToSession(row), indexRow: row });
    };
    for (const row of readWorkerRows(context)) addIndexRow(row);
    if (scanSessions) {
      for (const session of mgr.listSessions({ includeClosed: false }) || []) {
        const tag = agentTagOf(session);
        add(session, tag);
        if (tag) upsertWorkerSessionDeferred(session, tag);
      }
    }
    for (const [tag, sessionId] of tags.entries()) {
      add(getLiveSession(sessionId), tag);
    }
    return rows;
  }

  function nextTag(agent, context = {}) {
    refreshTagsFromSessions({ context });
    // Auto tags are agent + a per-agent local index with NO hyphen
    // ("worker3", "heavy-worker7", or "agent1" when the agent is unset). The
    // index is the max existing `^agent(\d+)$` + 1, escaping the agent so a
    // hyphenated agent ("heavy-worker") is matched literally. Keep incrementing
    // on any live collision.
    const base = clean(agent) || 'agent';
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(\\d+)$`);
    let maxN = 0;
    for (const existing of tags.keys()) {
      const match = re.exec(existing);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
    let n = maxN + 1;
    let tag = `${base}${n}`;
    while (resolveTag(tag, context)) tag = `${base}${++n}`;
    return tag;
  }

  function refreshTagsFromSessions({ scanSessions = false, context = {} } = {}) {
    const indexedRows = refreshTagsFromIndex(context);
    const indexedKeys = new Set(indexedRows.map((row) => `${row.tag}\0${row.sessionId}`));
    for (const [tag, sessionId] of [...tags.entries()]) {
      if (indexedKeys.has(`${tag}\0${sessionId}`)) continue;
      const session = getLiveSession(sessionId);
      if (!session || session.closed) tags.delete(tag);
    }
    if (!scanSessions) return;
    for (const session of mgr.listSessions({ includeClosed: false }) || []) {
      const tag = agentTagOf(session);
      if (!tag || tags.has(tag)) continue;
      if (!sessionMatchesContext(session, context)) continue;
      tags.set(tag, session.id);
      if (session.agent) tagAgents.set(tag, session.agent);
      if (session.cwd) tagCwds.set(tag, session.cwd);
      upsertWorkerSessionDeferred(session, tag);
    }
  }

  function bindTag(tag, session, extra = {}) {
    if (!tag || !session?.id) return;
    tags.set(tag, session.id);
    if (session.agent) tagAgents.set(tag, session.agent);
    if (session.cwd) tagCwds.set(tag, session.cwd);
    upsertWorkerSessionDeferred(session, tag, extra);
  }

  function forgetTag(tag) {
    if (!tag) return;
    const sessionId = tags.get(tag) || '';
    tags.delete(tag);
    tagAgents.delete(tag);
    tagCwds.delete(tag);
    removeWorkerRow({ tag, sessionId });
  }

  function cancelReap(sessionId) {
    const handle = reapTimers.get(sessionId);
    if (!handle) return false;
    clearTimeout(handle);
    reapTimers.delete(sessionId);
    return true;
  }

  function scheduleReap(sessionId, provider = null) {
    if (!sessionId) return;
    cancelReap(sessionId);
    const reapProvider = provider || getLiveSession(sessionId)?.provider || null;
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      try { mgr.hideSessionFromList?.(sessionId); } catch {}
      const tag = tagForSession(sessionId);
      if (tag) forgetTag(tag);
      removeWorkerRow({ tag, sessionId });
      clearAgentStatuslineRoute(sessionId);
      try { mgr.closeSession(sessionId, 'terminal-reap'); } catch {}
    }, reapMsForProvider(reapProvider));
    handle.unref?.();
    reapTimers.set(sessionId, handle);
  }

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

  function resolvePreset(config, args) {
    if (args.provider && args.model) {
      return {
        presetName: args.preset || '__direct__',
        preset: {
          id: '__direct__',
          name: '__DIRECT__',
          type: 'agent',
          provider: clean(args.provider),
          model: clean(args.model),
          effort: clean(args.effort) || undefined,
          fast: args.fast === true,
          tools: 'full',
        },
      };
    }

    const agentName = normalizeAgentName(args.agent);
    const configuredDefault = clean(config?.defaultProvider);
    const fallbackProvider = configuredDefault && isKnownProvider(configuredDefault)
      ? configuredDefault
      : DEFAULT_PROVIDER;
    const agentRoute = !clean(args.preset)
      ? (normalizeAgentRoute(config?.agents?.[agentName], fallbackProvider)
        || (agentName === 'maintainer' ? normalizeAgentRoute(config?.agents?.maintenance, fallbackProvider) : null))
      : null;
    if (agentRoute) {
      return {
        presetName: agentPresetName(agentName),
        preset: {
          id: `agent-${agentName}`,
          name: agentPresetName(agentName),
          type: 'agent',
          provider: agentRoute.provider,
          model: agentRoute.model,
          effort: agentRoute.effort,
          fast: agentRoute.fast === true,
          tools: 'full',
        },
      };
    }

    const presetName = clean(args.preset) || DEFAULT_AGENT_PRESETS[agentName];
    if (!presetName) throw new Error(`agent: agent "${agentName}" has no model assignment`);
    const preset = findPreset(config, presetName) || synthesizePreset(config, presetName);
    if (!preset) throw new Error(`agent: preset "${presetName}" not found`);
    return { presetName, preset };
  }

  function list({ scanSessions = false, context = {} } = {}) {
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
    return rows;
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
    const rows = listBackgroundTasks({ surface: 'agent', context }).map((task) => ({
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
      ...jobWorkerSnapshot(task.sessionId),
      ...sessionProgressExtras(task.sessionId, task.agent || null, Date.now(), task.status),
    }));
    return wantedPid ? rows.filter((row) => positiveInt(row.clientHostPid) === wantedPid) : rows;
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

  function renderJob(job, includeResult = false) {
    const meta = job.meta || {};
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
      ...jobWorkerSnapshot(meta.sessionId),
      ...progress,
      ...(includeResult && job.result !== undefined ? { result: job.result } : {}),
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
      try { resolved = resolvePreset(cfgMod.loadConfig(), args)?.preset || null; }
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

  function closePreparedSpawn(prepared, reason = 'agent-task-cancel') {
    if (!prepared?.session?.id) return;
    try { mgr.closeSession(prepared.session.id, reason); } catch {}
    try { clearAgentStatuslineRoute(prepared.session.id); } catch {}
    if (prepared.tag) forgetTag(prepared.tag);
    removeWorkerRow({ tag: prepared.tag, sessionId: prepared.session.id });
  }

  // Owner/worker completion notification lives in ./agent-tool/notify.mjs; the
  // factory captures mgr and registers the canonical completion fallback.
  const { workerNotifyFn, notifyOwnerAgentCompletionEarly } = createNotify(mgr);

  function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const jobMeta = sanitizeTaskMeta({
      ...(meta || {}),
      ...(clientHostPid ? { clientHostPid } : {}),
    });
    let task;
    task = startBackgroundTask({
      surface: 'agent',
      operation: type,
      label: jobMeta?.tag || jobMeta?.sessionId || type,
      input: { type, tag: jobMeta?.tag || null, sessionId: jobMeta?.sessionId || null, agent: jobMeta?.agent || null },
      context: notifyContext,
      meta: jobMeta,
      resultType: 'agent_task_result',
      renderResult: (result) => renderResult(result),
      cancel: () => {
        const currentMeta = task?.meta || jobMeta;
        if (currentMeta?.sessionId) {
          try { mgr.closeSession(currentMeta.sessionId, 'agent-task-cancel'); } catch {}
        }
      },
      run: async () => {
        // Yield one macrotask before doing agent work. startBackgroundTask uses
        // a Promise microtask, which otherwise begins CPU-heavy spawn prep
        // before the TUI receives/render the "running" result.
        await new Promise((resolve) => setImmediate(resolve));
        if (task?.status === 'cancelled') return null;
        return await run(task);
      },
    });
    return task;
  }

  function startDeferredSpawnJob(args, callerCwd, context, notifyContext, extras = {}) {
    return startJob('spawn', pendingSpawnMeta(args, extras), async (job) => {
      // Stagger concurrent spawn starts before prep/model-call begins (see
      // SPAWN_STAGGER_MS above). Runs inside the job body, so the tool call
      // that queued this job already returned task_id before this awaits.
      await waitForSpawnStagger();
      if (job?.status === 'cancelled') return null;
      // prepareSpawn (ensureProvider/prepareAgentSession) runs before runSpawn
      // installs its progress watchdog, so guard prep with an internal env-
      // backed cap rather than exposing per-call timeout knobs on the agent
      // tool surface.
      const prepDeadlineMs = nonNegativeInt(args.spawnPrepTimeoutMs ?? args.prepTimeoutMs)
        ?? DEFAULT_SPAWN_PREP_TIMEOUT_MS;
      let prepared;
      const prepState = { timedOut: false };
      if (prepDeadlineMs > 0) {
        let prepTimer = null;
        let timedOut = false;
        // If prep wins the race we use its result. If the timeout wins, the
        // prepareSpawn promise may still resolve later with a fully-built
        // session/tag/route — attach a cleanup so the late-arriving prepared is
        // torn down, otherwise the orphaned tag would collide on re-spawn.
        const prepPromise = prepareSpawn(args, callerCwd, context, prepState);
        prepPromise.then((late) => {
          if (timedOut) closePreparedSpawn(late, 'agent-spawn-prep-timeout');
        }, () => {});
        const timeout = new Promise((_resolve, reject) => {
          prepTimer = setTimeout(() => {
            timedOut = true;
            prepState.timedOut = true;
            reject(new Error(`agent spawn prep timed out (${prepDeadlineMs}ms) before model request`));
          }, prepDeadlineMs);
          prepTimer.unref?.();
        });
        try {
          prepared = await Promise.race([prepPromise, timeout]);
        } finally {
          if (prepTimer) clearTimeout(prepTimer);
        }
      } else {
        prepared = await prepareSpawn(args, callerCwd, context, prepState);
      }
      mergeJobMeta(job, preparedSpawnMeta(prepared, extras));
      upsertWorkerSessionDeferred(prepared.session, prepared.tag, {
        ...preparedSpawnMeta(prepared, extras),
        status: 'running',
        stage: 'running',
        task_id: job.taskId,
        startedAt: job.startedAt,
      });
      if (job?.status === 'cancelled') {
        closePreparedSpawn(prepared);
        return null;
      }
      return await runSpawn(prepared, notifyContext, job);
    }, notifyContext);
  }

  function startProgressIdleWatchdog(sessionId, watchdogPolicy, agent = null) {
    if (!sessionId || !agentWatchdogPolicyActive(watchdogPolicy)) return null;
    if (typeof mgr.getSessionProgressSnapshot !== 'function' && typeof mgr.getSessionLastProgressAt !== 'function') return null;
    if (typeof mgr.linkParentSignalToSession !== 'function') return null;
    const controller = new AbortController();
    const anchorTs = Date.now();
    try { mgr.linkParentSignalToSession(sessionId, controller.signal); } catch { return null; }
    const timer = setInterval(() => {
      if (controller.signal?.aborted) return;
      const now = Date.now();
      const snapshot = typeof mgr.getSessionProgressSnapshot === 'function'
        ? mgr.getSessionProgressSnapshot(sessionId)
        : null;
      const abortErr = snapshot
        ? evaluateAgentWatchdogAbort(snapshot, now, watchdogPolicy)
        : null;
      const sess = typeof mgr.getSession === 'function' ? mgr.getSession(sessionId) : null;
      const iteration = typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null;
      if (!abortErr && !snapshot) {
        const reported = mgr.getSessionLastProgressAt(sessionId);
        const last = reported || anchorTs;
        if (watchdogPolicy.idleStaleMs > 0 && now - last > watchdogPolicy.idleStaleMs) {
          abortAgentProgressWatchdog(controller, {
            sessionId,
            agent,
            error: new AgentStallAbortError(`agent task stale (${watchdogPolicy.idleStaleMs}ms without progress)`),
            policy: watchdogPolicy,
            now,
            anchorTs,
            lastProgressAt: reported,
            iteration,
          });
        }
        return;
      }
      if (abortErr) {
        abortAgentProgressWatchdog(controller, {
          sessionId,
          agent,
          error: abortErr,
          snapshot,
          policy: watchdogPolicy,
          now,
          anchorTs,
          iteration,
        });
      }
    }, 1000);
    timer.unref?.();
    return {
      stop: () => {
        try { clearInterval(timer); } catch {}
      },
    };
  }

  async function prepareSpawn(args, callerCwd = null, context = {}, prepState = null) {
    refreshTagsFromSessions({ context });
    const config = cfgMod.loadConfig();
    const agent = normalizeAgentName(args.agent);
    if (!agent) throw new Error('agent spawn: agent is required');
    const agentPermission = readAgentFrontmatterPermission(agent, dataDir, STANDALONE_SOURCE_ROOT);
    const agentPerm = normalizeAgentPermission(agentPermission) || null;
    const { presetName, preset } = resolvePreset(config, args);
    await ensureProvider(config, preset.provider);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }

    const tag = clean(args.tag) || nextTag(agent, context);
    // Any resolved same-tag binding in this terminal (live or lingering trace)
    // blocks a fresh spawn. execute() routes live reuse before prepareSpawn.
    if (resolveTag(tag, context, { scanSessions: wantsSessionScan(args) })) {
      throw new Error(`agent spawn: tag "${tag}" already exists`);
    }
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'agent', agentId: tag });
    const maxLoopIterations = positiveInt(args.maxLoopIterations) || null;
    const watchdogPolicy = resolveAgentWatchdogPolicy(agent);
    const { session, effectiveCwd } = prepareAgentSession({
      agent,
      presetName,
      preset,
      runtimeSpec,
      owner: AGENT_OWNER,
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: agent,
      parentSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      ownerSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      clientHostPid: terminalPidForContext(context) || null,
      agentTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      maxLoopIterations: maxLoopIterations || undefined,
      permission: agentPerm || undefined,
      cacheKeyOverride: args.cacheKey || undefined,
    });
    // Lead sessions write a gateway-session route when created; agent sessions
    // are built through prepareAgentSession(), so mirror that registration here
    // or the vendored L1/L2 statusline cannot resolve the agent route/model.
    writeAgentStatuslineRoute(session.id, preset);
    bindTag(tag, session, {
      agent,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'idle',
      stage: 'idle',
    });
    cancelReap(session.id);
    return {
      args,
      tag,
      session,
      agent,
      preset,
      presetName,
      workerCwd: effectiveCwd || workerCwd,
      prompt,
      maxLoopIterations,
      watchdogPolicy,
    };
  }

  async function runSpawn(prepared, notifyContext = null, job = null) {
    const { args, tag, session, agent, preset, presetName, workerCwd, prompt, watchdogPolicy } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, watchdogPolicy, agent);
    let finalStatus = 'idle';
    // SubagentStart: a worker session is about to run its first turn.
    emitSubagentEvent('start', agent, { session_id: session.id, tag });
    upsertWorkerSessionDeferred(session, tag, {
      agent,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'running',
      stage: 'running',
    });
    let handoffMsgStart = 0;
    try {
      const completionValue = (result) => {
        // Promote an abnormal finish (iteration cap, truncation, or a public
        // agent's empty terminal turn) to an explicit error, so the Lead
        // receives it as a failure with an accurate reason instead of a silent
        // `completed` empty result. Keyed off loop.mjs terminationReason;
        // hidden agents finishing normally-empty are left untagged (benign).
        const abnormalError = abnormalEmptyFinishError(result, agent);
        return {
          tag,
          sessionId: session.id,
          agent,
          preset: presetKey(preset) || presetName,
          provider: preset.provider,
          model: preset.model,
          effort: preset.effort || null,
          fast: preset.fast === true,
          content: result?.content || '',
          ...(abnormalError ? { error: abnormalError } : {}),
        };
      };
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(session.id));
      const result = await mgr.askSession(session.id, prompt, args.context || null, null, workerCwd, null, {
        notifyFn: workerNotifyFn(session.id, notifyContext || {}),
        ...(job ? {
          onTerminalResult: (terminalResult) => {
            const value = completionValue(terminalResult);
            if (job) job._terminalResultValue = value;
            notifyOwnerAgentCompletionEarly(job, value, notifyContext || {});
            // Mark the task terminal the moment the worker produces its final
            // result, so a hung/slow post-result session save cannot strand the
            // task (and the status card) in `running`. Idempotent; the finally
            // reconcile remains a backup for the error/no-terminal-result path.
            if (job?.taskId) {
              try {
                // An empty/abnormal finish is a failure, not a completion:
                // reconcile as `failed` with the accurate error so the Lead
                // card renders `error: …` instead of a header-only empty card.
                reconcileBackgroundTask(job.taskId, value.error
                  ? {
                      status: 'failed',
                      result: value,
                      error: value.error,
                      terminalReason: 'agent-empty-final',
                    }
                  : {
                      status: 'completed',
                      result: value,
                      terminalReason: 'agent-terminal-result',
                    });
              } catch {}
            }
          },
        } : {}),
      });
      // The early preview no longer promises body suppression, so the canonical
      // notifyTaskCompletion is left to fire exactly once with output via the
      // resolve/reconcile/finally path.
      const finalValue = completionValue(result);
      // Non-job return path (or job path where the terminal-result reconcile
      // already ran): if the finish was abnormal-empty, surface it as a thrown
      // error so finalStatus becomes 'error' and the caller's error path (and
      // the finally reconcile below, as `failed`) render the accurate reason.
      if (finalValue.error) {
        finalStatus = 'error';
        if (job) job._terminalResultValue = finalValue;
        throw new Error(finalValue.error);
      }
      return finalValue;
    } catch (error) {
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(session.id), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          tag,
          sessionId: session.id,
          agent,
          preset: presetKey(preset) || presetName,
          provider: preset.provider,
          model: preset.model,
          effort: preset.effort || null,
          fast: preset.fast === true,
          content: partial,
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        if (job?.taskId) {
          try {
            reconcileBackgroundTask(job.taskId, {
              status: 'completed',
              result: value,
              terminalReason: 'agent-watchdog-partial',
            });
          } catch {}
        }
        return value;
      }
      finalStatus = 'error';
      // Part C: a mid-stream stall (StreamStalledError / ESTREAMSTALL) throws
      // here WITHOUT a terminal result, so the finally reconcile below (gated on
      // _terminalResultValue) would be skipped and only the outer task-reject
      // path would notify. Belt-and-suspenders: reconcile this job to `failed`
      // now so the owner (Lead) always gets a failure notification instead of a
      // task stranded in `running`. Idempotent — completeBackgroundTask no-ops
      // once terminal, so the outer reject path can't double-notify.
      if (job?.taskId && job._terminalResultValue === undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: 'failed',
            error,
            terminalReason: 'agent-stream-stalled',
          });
        } catch {}
      }
      throw error;
    } finally {
      watchdog?.stop?.();
      upsertWorkerSessionDeferred(session, tag, {
        agent,
        preset: presetKey(preset) || presetName,
        provider: preset.provider,
        model: preset.model,
        effort: preset.effort || null,
        fast: preset.fast === true,
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      // Safety net: if a post-result step (session save) hung or threw after the
      // worker already produced a terminal result, the task could otherwise be
      // stranded in `running`. Reconcile it to a terminal state using the
      // captured result so the owner gets a completion notification + the
      // statusline clears. Idempotent once the task is already terminal.
      if (job && job._terminalResultValue !== undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: finalStatus === 'error' ? 'failed' : 'completed',
            result: job._terminalResultValue,
            ...(finalStatus === 'error' && job._terminalResultValue?.error
              ? { error: job._terminalResultValue.error }
              : {}),
            terminalReason: 'agent-finally-reconcile',
          });
        } catch {}
      }
      scheduleReap(session.id);
      // SubagentStop: worker finished (terminal), regardless of outcome.
      emitSubagentEvent('stop', agent, { session_id: session.id, tag, status: finalStatus });
    }
  }

  async function spawn(args) {
    return await runSpawn(await prepareSpawn(args));
  }

  async function prepareSend(args, context = {}) {
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context });
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('agent send: tag or sessionId is required');
    const sessionId = resolveTag(target, context, { scanSessions: wantsSessionScan(args) });
    if (!sessionId) throw new Error(`agent send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`agent send: session "${sessionId}" is closed`);
    cancelReap(sessionId);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    return { args, session, sessionId, prompt };
  }

  async function runSend(prepared, notifyContext = null, job = null) {
    const { args, session, sessionId, prompt } = prepared;
    const sendAgent = session.agent || normalizeAgentName(args.agent);
    const watchdog = startProgressIdleWatchdog(sessionId, resolveAgentWatchdogPolicy(sendAgent), sendAgent);
    const tag = tagForSession(sessionId);
    let finalStatus = 'idle';
    upsertWorkerSessionDeferred(session, tag, { status: 'running', stage: 'running' });
    let handoffMsgStart = 0;
    try {
      const completionValue = (result) => {
        // Same abnormal-empty → error promotion as runSpawn: a reused/`send`
        // worker that hits the cap, truncates, or finishes empty must surface
        // as a failure with an accurate reason, not a silent completed empty.
        const abnormalError = abnormalEmptyFinishError(result, session.agent || sendAgent);
        return {
          tag,
          sessionId,
          agent: session.agent || null,
          provider: session.provider,
          model: session.model,
          content: result?.content || '',
          ...(abnormalError ? { error: abnormalError } : {}),
        };
      };
      handoffMsgStart = resolveHandoffMessageStartIndex(mgr.getSession(sessionId));
      const result = await mgr.askSession(sessionId, prompt, args.context || null, null, session.cwd || defaultCwd, null, {
        notifyFn: workerNotifyFn(sessionId, notifyContext || {}),
        ...(job ? {
          onTerminalResult: (terminalResult) => {
            const value = completionValue(terminalResult);
            if (job) job._terminalResultValue = value;
            notifyOwnerAgentCompletionEarly(job, value, notifyContext || {});
            // Mark terminal as soon as the worker's final result lands so a slow
            // post-result save can't strand the task in `running`. Idempotent.
            if (job?.taskId) {
              try {
                reconcileBackgroundTask(job.taskId, value.error
                  ? {
                      status: 'failed',
                      result: value,
                      error: value.error,
                      terminalReason: 'agent-empty-final',
                    }
                  : {
                      status: 'completed',
                      result: value,
                      terminalReason: 'agent-terminal-result',
                    });
              } catch {}
            }
          },
        } : {}),
      });
      // Early preview no longer suppresses the canonical body notification;
      // notifyTaskCompletion fires once with output via resolve/reconcile.
      const finalValue = completionValue(result);
      if (finalValue.error) {
        finalStatus = 'error';
        if (job) job._terminalResultValue = finalValue;
        throw new Error(finalValue.error);
      }
      return finalValue;
    } catch (error) {
      const partial = watchdogPartialHandoffFromError(error, mgr.getSession(sessionId), handoffMsgStart);
      if (partial) {
        finalStatus = 'idle';
        const value = {
          tag,
          sessionId,
          agent: session.agent || null,
          provider: session.provider,
          model: session.model,
          content: partial,
          stallAbort: true,
        };
        if (job) job._terminalResultValue = value;
        if (job?.taskId) {
          try {
            reconcileBackgroundTask(job.taskId, {
              status: 'completed',
              result: value,
              terminalReason: 'agent-watchdog-partial',
            });
          } catch {}
        }
        return value;
      }
      finalStatus = 'error';
      // Part C (send path mirror): a mid-stream stall throws with no terminal
      // result — reconcile to `failed` so the owner is notified rather than the
      // task hanging in `running`. Idempotent (see runSpawn note).
      if (job?.taskId && job._terminalResultValue === undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: 'failed',
            error,
            terminalReason: 'agent-stream-stalled',
          });
        } catch {}
      }
      throw error;
    } finally {
      watchdog?.stop?.();
      upsertWorkerSessionDeferred(session, tag, {
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      // Safety net mirror of runSpawn: reconcile a stranded task if a post-result
      // step hung/threw after a terminal result was already produced.
      if (job && job._terminalResultValue !== undefined) {
        try {
          reconcileBackgroundTask(job.taskId, {
            status: finalStatus === 'error' ? 'failed' : 'completed',
            result: job._terminalResultValue,
            ...(finalStatus === 'error' && job._terminalResultValue?.error
              ? { error: job._terminalResultValue.error }
              : {}),
            terminalReason: 'agent-finally-reconcile',
          });
        } catch {}
      }
      scheduleReap(sessionId);
    }
  }

  async function send(args) {
    return await runSend(await prepareSend(args));
  }

  // Shared send dispatch for an already-resolved live session. Used by the
  // `send` branch AND by the `spawn` branch when an explicit tag maps to a
  // live session (reuse path). Busy sessions queue the prompt; idle ones run a
  // background send job that continues the existing session (context kept).
  function dispatchToExistingSession(prepared, notifyContext, extras = {}) {
    if (isSessionBusy(prepared.sessionId) && typeof mgr.enqueuePendingMessage === 'function') {
      const queueDepth = mgr.enqueuePendingMessage(prepared.sessionId, prepared.prompt);
      return renderResult({
        queued: true,
        ...extras,
        tag: tagForSession(prepared.sessionId),
        sessionId: prepared.sessionId,
        agent: prepared.session.agent || null,
        queueDepth,
      });
    }
    const job = startJob('send', {
      tag: tagForSession(prepared.sessionId),
      sessionId: prepared.sessionId,
      agent: prepared.session.agent || null,
      provider: prepared.session.provider || null,
      model: prepared.session.model || null,
      preset: prepared.session.presetName || null,
      effort: prepared.session.effort || null,
      fast: prepared.session.fast === true,
    }, (job) => runSend(prepared, notifyContext, job), notifyContext);
    return renderResult({ ...extras, ...renderJob(job, false) });
  }

  function close(args, context = {}) {
    const scopedContext = agentScope(args, context);
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context: scopedContext });
    const taskId = taskIdFromArgs(args);
    const task = taskId ? getBackgroundTask(taskId, { surface: 'agent', context }) : null;
    const taskMeta = task?.meta || {};
    const target = clean(args.tag || args.sessionId || taskMeta.sessionId);
    if (!target) {
      if (task?.taskId) {
        cancelBackgroundTask(task.taskId, 'cancelled by agent close');
        return { closed: true, tag: taskMeta.tag || null, sessionId: null, task_id: task.taskId };
      }
      throw new Error('agent close: tag or sessionId is required');
    }
    const sessionId = resolveTag(target, scopedContext, { scanSessions: wantsSessionScan(args) });
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagAgents.has(target)) {
        forgetTag(target);
        if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by agent close');
        return { closed: true, forgotten: true, tag: target, sessionId: null, task_id: task?.taskId || null };
      }
      throw new Error(`agent close: target "${target}" not found`);
    }
    cancelReap(sessionId);
    const tag = tagForSession(sessionId);
    if (tag) forgetTag(tag);
    removeWorkerRow({ tag, sessionId });
    clearAgentStatuslineRoute(sessionId);
    // Cancel any running background task bound to this session BEFORE closing
    // the session. Otherwise closeSession rejects the in-flight runSpawn with
    // "Session closed: closeSession" and the catch path reconciles the task as
    // `failed` — a user-initiated close must surface as `cancelled` instead.
    // (The explicit task_id path below stays as a no-op fallback: cancel is
    // idempotent once terminal.)
    for (const row of listBackgroundTasks({ surface: 'agent', context: scopedContext })) {
      if (row.sessionId !== sessionId && row.tag !== target) continue;
      cancelBackgroundTask(row.task_id, 'cancelled by agent close');
    }
    const ok = mgr.closeSession(sessionId, 'cli-agent-close');
    if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by agent close');
    return { closed: ok, tag, sessionId, task_id: task?.taskId || null };
  }

  function cleanup(args = {}, context = {}) {
    const scopedContext = agentScope(args, context);
    const beforeTags = tags.size;
    refreshTagsFromSessions({ scanSessions: wantsSessionScan(args), context: scopedContext });
    const cleaned = cleanupBackgroundTasks({ surface: 'agent', context: scopedContext, force: args.force === true });
    return {
      tasksRemoved: cleaned.removed,
      tagsRemoved: beforeTags - tags.size,
      tasks: listJobs(scopedContext).length,
      workers: list({ scanSessions: wantsSessionScan(args), context: scopedContext }).length,
    };
  }

  function closeAll(reason = 'cli-agent-close-all') {
    refreshTagsFromSessions({ scanSessions: false });
    const closed = [];
    const failed = [];
    for (const { tag, session } of agentSessionEntries({ scanSessions: false, context: {} })) {
      try {
        closed.push(close({ sessionId: session.id }));
      } catch (err) {
        failed.push({ tag, error: presentErrorText(err, { surface: 'agent' }) });
      }
    }
    for (const task of listBackgroundTasks({ surface: 'agent' })) {
      if (task?.status !== 'running') continue;
      cancelBackgroundTask(task.task_id, reason);
      closed.push({ closed: true, tag: task.tag || null, sessionId: task.sessionId || null, task_id: task.task_id });
    }
    for (const timer of reapTimers.values()) clearTimeout(timer);
    reapTimers.clear();
    flushWorkerIndexMutations();
    writeWorkerRows((byKey) => byKey.clear());
    return { closed, failed };
  }

  // True when a tag has a lingering worker-index / role trace but no live
  // session in this terminal (finished worker still inside the reap grace window).
  function terminalWorkerRowForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value) return null;
    return readWorkerRows(context).find((row) => {
      if (clean(row.tag) !== value) return false;
      if (!isTerminalWorkerStatus(row.status || row.stage)) return false;
      if (getLiveSession(clean(row.sessionId))) return false;
      return true;
    }) || null;
  }

  function hasTerminalTrace(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    if (resolveTag(value, context, { excludeTerminalTraces: true })) return false; // live -> reuse, not trace
    return Boolean(terminalWorkerRowForTag(value, context));
  }

  function reapTerminalTraceForTag(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    if (!hasTerminalTrace(value, context)) return false;
    refreshTagsFromSessions({ context });
    let sessionId = tags.get(value) || '';
    if (!sessionId) {
      const row = readWorkerRows(context).find((item) => clean(item.tag) === value);
      sessionId = clean(row?.sessionId) || '';
    }
    if (sessionId) cancelReap(sessionId);
    forgetTag(value);
    removeWorkerRow({ tag: value, sessionId });
    return true;
  }

  async function execute(args = {}, context = {}) {
    try {
      const type = clean(args.type) || 'spawn';
      const callerCwd = clean(context.cwd || context.callerCwd);
      const scopedContext = agentScope(args, context);
      const notifyContext = context;
      if (type === 'list') return renderResult({ workers: list({ scanSessions: wantsSessionScan(args), context: scopedContext }), jobs: listJobs(scopedContext) });
      if (type === 'status') return renderResult(renderJob(getJob(args, scopedContext), false));
      if (type === 'read') return renderResult(renderJob(getJob(args, scopedContext), true));
      if (type === 'cleanup') return renderResult(cleanup(args, scopedContext));
      if (type === 'cancel') return renderResult(close(args, scopedContext));
      if (type === 'close') return renderResult(close(args, scopedContext));
      if (type === 'send') {
        try {
          const prepared = await prepareSend(args, scopedContext);
          return dispatchToExistingSession(prepared, notifyContext);
        } catch (err) {
          // Reaped/dead-tag fallback: with the 5m terminal-reap window a
          // same-scope follow-up often lands after the session is gone.
          // Instead of bouncing an error back to Lead (who would just
          // re-issue the same content as a spawn), respawn a FRESH session
          // under the same tag with the message as its brief. `respawned:
          // true` in the result tells Lead the worker has no prior session
          // context — re-supply anchors on the next send if needed.
          // Only tag-addressed sends fall back; explicit sessionId sends
          // keep erroring (caller pinned a specific session on purpose).
          const fallbackTag = clean(args.tag);
          const isDeadTarget = /not found|is closed/i.test(String(err?.message || ''));
          if (!fallbackTag || fallbackTag.startsWith('sess_') || !isDeadTarget) throw err;
          const prompt = clean(args.message || args.prompt);
          if (!prompt) throw err;
          // Inherit the dead session's agent/cwd so the auto-respawn doesn't
          // die on "agent spawn: agent is required" when Lead's send (correctly)
          // omitted them. Read BEFORE forgetTag wipes the registry entries.
          //
          // Root cause of the surfaced "target not found" errors: when a tag is
          // FULLY reaped (session gone past the 5m grace window), the in-memory
          // tagAgents/tagCwds maps are cleared, so inheritedAgent came back empty
          // and this path re-threw instead of respawning. Recover the agent/cwd
          // from the persisted worker row, then fall back to the default `worker`
          // agent so an unknown-but-plausible tag still cold-respawns. The guards
          // above (empty tag / raw sess_ id / non-dead error) keep plainly invalid
          // targets erroring.
          // readWorkerRows is already scoped to THIS terminal (clientHostPid,
          // via rowMatchesContext), so inheritedRow — and every mutation below
          // keyed on its sessionId — never touches another terminal's same-tag
          // worker row.
          let inheritedRow = null;
          try {
            inheritedRow = readWorkerRows(scopedContext).find((row) => clean(row.tag) === fallbackTag) || null;
          } catch { inheritedRow = null; }
          // Gate the respawn on evidence the tag previously existed IN THIS
          // terminal: a persisted, clientHostPid-scoped worker row. The
          // in-memory tags/tagAgents/tagCwds maps are NOT reliable evidence —
          // closeAll() calls refreshTagsFromSessions() with NO context
          // (see ~L1501), which populates them from EVERY terminal's rows
          // (readWorkerRows({}) — rowMatchesContext returns true with no pid),
          // so they can hold a peer terminal's tag. A typo'd / never-existed
          // tag has no scoped row and must keep the original "not found" error.
          if (!inheritedRow) throw err;
          const inheritedSessionId = clean(inheritedRow.sessionId);
          const inheritedAgent = clean(args.agent) || clean(inheritedRow.agent) || 'worker';
          const inheritedCwd = clean(args.cwd) || clean(inheritedRow.cwd) || clean(callerCwd);
          // Drop this terminal's in-memory trace and remove ONLY the persisted
          // row matching inheritedRow.sessionId. Do NOT call forgetTag here: it
          // does a tag-wide removeWorkerRow({tag,sessionId}) (L556) whose OR
          // match (L395) would delete peer terminals' same-tag rows. The map
          // deletes are guarded on the tag pointing at OUR sessionId so a peer
          // cache entry (see above) is left intact (it rebuilds from rows).
          if (tags.get(fallbackTag) === inheritedSessionId) {
            try { tags.delete(fallbackTag); tagAgents.delete(fallbackTag); tagCwds.delete(fallbackTag); } catch {}
          }
          if (inheritedSessionId) { try { removeWorkerRow({ sessionId: inheritedSessionId }); } catch {} }
          const spawnArgs = {
            ...args,
            type: 'spawn',
            tag: fallbackTag,
            prompt,
            message: undefined,
            agent: inheritedAgent,
            ...(inheritedCwd ? { cwd: inheritedCwd } : {}),
          };
          const job = startDeferredSpawnJob(spawnArgs, callerCwd, context, notifyContext, { respawned: true });
          return renderResult(renderJob(job, false));
        }
      }
      if (type === 'spawn') {
        // Explicit-tag spawn priority (auto nextTag always creates a fresh session):
        //   1) live + busy -> queue the prompt (reuse)
        //   2) live + idle -> continue existing session (reuse)
        //   3) lingering terminal trace -> reap trace and fresh spawn under same tag
        //   4) genuinely new tag -> fresh deferred spawn
        const explicitTag = clean(args.tag);
        if (explicitTag) {
          // Resolve a LIVE same-tag session in this terminal (busy or idle).
          let liveSessionId = null;
          try {
            liveSessionId = resolveTag(explicitTag, scopedContext, {
              scanSessions: wantsSessionScan(args),
              excludeTerminalTraces: true,
            });
          } catch {
            // Ambiguous across terminals — fall through to the normal spawn
            // path which surfaces the same error consistently.
            liveSessionId = null;
          }
          if (liveSessionId && getLiveSession(liveSessionId)) {
            // Reuse the existing session via the send path (context preserved).
            const prepared = await prepareSend({ ...args, tag: explicitTag }, scopedContext);
            return dispatchToExistingSession(prepared, notifyContext, { reused: true });
          }
          if (hasTerminalTrace(explicitTag, scopedContext)) {
            reapTerminalTraceForTag(explicitTag, scopedContext);
          }
        }
        const job = startDeferredSpawnJob(args, callerCwd, context, notifyContext);
        return renderResult(renderJob(job, false));
      }
      throw new Error(`agent: unknown type "${type}"`);
    } catch (err) {
      return errorLine(err, { surface: 'agent' });
    }
  }

  return {
    tools: [AGENT_TOOL],
    execute,
    getStatus: (context = {}) => {
      const scopedContext = agentScope({}, context);
      const pid = terminalPidForContext(scopedContext);
      return {
        workers: list({ scanSessions: false, context: scopedContext }),
        jobs: listJobs(scopedContext),
        scope: pid ? { clientHostPid: pid } : { allTerminals: true },
      };
    },
    recoverWorkers: (context = {}) => {
      const scopedContext = agentScope({ recover: true }, context);
      refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
      return list({ scanSessions: false, context: scopedContext });
    },
    closeAll,
  };
}