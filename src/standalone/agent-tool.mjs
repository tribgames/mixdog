import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  renderBackgroundTask,
  reconcileBackgroundTask,
  setBackgroundTaskEnqueueFallback,
  startBackgroundTask,
  sanitizeTaskMeta,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { modelVisibleToolCompletionMessage } from '../runtime/shared/tool-execution-contract.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { updateJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';
import {
  normalizeAgentPermission,
  normalizeAgentPermissionOrNone,
  parseMarkdownFrontmatter,
} from '../runtime/shared/markdown-frontmatter.mjs';
import { prepareAgentSession } from '../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import {
  agentWatchdogPolicyActive,
  evaluateAgentWatchdogAbort,
  resolveAgentWatchdogPolicy,
} from '../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import {
  appendAgentProgressKv,
  buildAgentTaskProgressFields,
} from './agent-task-status.mjs';
import { AGENT_OWNER } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { clearGatewaySessionRoute, writeGatewaySessionRoute } from '../vendor/statusline/src/gateway/session-routes.mjs';

const STANDALONE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

const DEFAULT_AGENT_PRESETS = Object.freeze({
  explore: 'sonnet-high',
  maintainer: 'haiku',
  worker: 'sonnet-high',
  'heavy-worker': 'sonnet-high',
  reviewer: 'opus-xhigh',
  debugger: 'opus-xhigh',
});

export const AGENT_TOOL = {
  name: 'agent',
  title: 'Agent',
  annotations: {
    title: 'Agent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    agentHidden: true,
  },
  description: 'Delegate scoped work. Agent handoffs always start background tasks and return task IDs immediately. Spawn independent agents in parallel with distinct tags; keep Lead work moving. Wait for the completion notification before dependent work. Do not call status/read after spawn; status/read are manual recovery only.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Action. Default spawn.' },
      task_id: { type: 'string', description: 'Manual recovery task ID.' },
      agent: { type: 'string', description: 'Workflow agent id.' },
      tag: { type: 'string', description: 'Stable distinct handle; choose an agent-index tag by agent, e.g. worker01, heavy-worker01, reviewer01.' },
      sessionId: { type: 'string', description: 'Raw sess_ id.' },
      prompt: { type: 'string', description: 'Scoped task brief.' },
      message: { type: 'string', description: 'Follow-up or brief.' },
      file: { type: 'string', description: 'Prompt file.' },
      cwd: { type: 'string', description: 'Working directory.' },
      context: { type: 'string', description: 'Extra agent context.' },
    },
    additionalProperties: true,
  },
};

const WORKER_INDEX_FILE = 'agent-workers.json';
function envTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Grace window during which a terminated/idle worker row is kept around so the
// same terminal can re-use (or cleanly re-spawn) the same tag. Cached as a
// constant like the other timeouts; override with MIXDOG_AGENT_TERMINAL_REAP_MS.
const TERMINAL_REAP_MS = envTimeoutMs('MIXDOG_AGENT_TERMINAL_REAP_MS', 60 * 60_000);
// Independent hard cap for the spawn *prep* phase (ensureProvider /
// prepareAgentSession / catalog+rules load). Kept separate from the
// first-response watchdog so prep cannot hang a whole fanout before the model
// request starts. Set MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS=0 to fully disable the
// cap and restore strictly-unbounded prep.
const DEFAULT_SPAWN_PREP_TIMEOUT_MS = envTimeoutMs('MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS', 120_000);
const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);

// Process-wide TTL cache for agent AGENT.md frontmatter permission. The file
// rarely changes, but readAgentFrontmatterPermission() otherwise pays several
// existsSync()+readFileSync() calls on EVERY spawn — multiplied across a
// parallel fanout that is pure redundant synchronous I/O on the event loop,
// which blocks every other concurrent spawn. Short TTL keeps edits picked up
// quickly while collapsing burst reads.
const _frontmatterPermCache = new Map(); // key -> { value, atMs }
const FRONTMATTER_PERM_CACHE_TTL_MS = envTimeoutMs('MIXDOG_AGENT_FRONTMATTER_TTL_MS', 5_000);

function clean(value) {
  return String(value ?? '').trim();
}

function agentTagOf(session) {
  return clean(session?.agentTag);
}

function normalizeAgentName(value) {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (id === 'explorer') return 'explore';
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  if (id === 'heavy' || id === 'heavyworker') return 'heavy-worker';
  if (id === 'review') return 'reviewer';
  if (id === 'debug') return 'debugger';
  return id;
}

function readAgentFrontmatterPermission(agent, dataDir) {
  const cleanAgent = clean(agent);
  if (!cleanAgent) return null;
  const cacheKey = `${dataDir || ''}\u0000${cleanAgent}`;
  const cached = _frontmatterPermCache.get(cacheKey);
  if (cached && Date.now() - cached.atMs < FRONTMATTER_PERM_CACHE_TTL_MS) {
    return cached.value;
  }
  const candidates = [];
  if (dataDir) {
    candidates.push(join(dataDir, 'agents', cleanAgent, 'AGENT.md'));
    candidates.push(join(dataDir, 'agents', `${cleanAgent}.md`));
  }
  candidates.push(join(STANDALONE_SOURCE_ROOT, 'agents', cleanAgent, 'AGENT.md'));
  candidates.push(join(STANDALONE_SOURCE_ROOT, 'agents', `${cleanAgent}.md`));
  let resolved = null;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const fm = parseMarkdownFrontmatter(readFileSync(file, 'utf8'));
    const permission = normalizeAgentPermissionOrNone(fm.permission);
    if (permission) { resolved = permission; break; }
  }
  _frontmatterPermCache.set(cacheKey, { value: resolved, atMs: Date.now() });
  return resolved;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function terminalPidForContext(context = {}) {
  return positiveInt(context?.clientHostPid);
}

function agentScope(args = {}, context = {}) {
  const scope = clean(args.scope || args.terminal || args.term).toLowerCase();
  if (args.allTerminals === true || scope === 'all' || scope === 'global') return {};
  return context || {};
}

function sessionMatchesContext(session, context = {}) {
  const wantedPid = terminalPidForContext(context);
  if (!wantedPid) return true;
  const sessionPid = positiveInt(session?.clientHostPid);
  return !!sessionPid && sessionPid === wantedPid;
}

function rowMatchesContext(row, context = {}) {
  const wantedPid = terminalPidForContext(context);
  if (!wantedPid) return true;
  const rowPid = positiveInt(row?.clientHostPid);
  return !!rowPid && rowPid === wantedPid;
}

function nonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function presetKey(preset) {
  return clean(preset?.id || preset?.name);
}

function bridgeRouteForStatusline(preset = {}) {
  const provider = clean(preset.provider);
  const model = clean(preset.model);
  if (!provider || !model) return null;
  const out = {
    mode: 'fixed',
    defaultProvider: provider,
    defaultModel: model,
  };
  const id = clean(preset.id);
  const name = clean(preset.name);
  const modelDisplay = clean(preset.modelDisplay || preset.display || preset.displayName);
  const effort = clean(preset.effort);
  if (id) out.presetId = id;
  if (name) out.presetName = name;
  if (modelDisplay) out.modelDisplay = modelDisplay;
  if (effort) {
    out.effort = effort;
    out.displayEffort = effort;
  }
  if (preset.fast === true || preset.fast === false) out.fast = preset.fast;
  return out;
}

function writeAgentStatuslineRoute(sessionId, preset) {
  const route = bridgeRouteForStatusline(preset);
  if (!sessionId || !route) return false;
  try { return writeGatewaySessionRoute(sessionId, route); } catch { return false; }
}

function clearAgentStatuslineRoute(sessionId) {
  if (!sessionId) return false;
  try { return clearGatewaySessionRoute(sessionId); } catch { return false; }
}

function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    return clean(p?.id).toLowerCase() === wanted || clean(p?.name).toLowerCase() === wanted;
  }) || null;
}

function synthesizePreset(config, key) {
  const alias = PRESET_ALIASES.get(clean(key).toLowerCase());
  if (!alias) return null;
  const base = findPreset(config, alias.base);
  if (!base) return null;
  return {
    ...base,
    id: alias.id,
    name: alias.name,
    effort: alias.effort,
  };
}

function normalizeAgentRoute(routeLike) {
  const provider = clean(routeLike?.provider);
  const model = clean(routeLike?.model);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    effort: clean(routeLike?.effort) || undefined,
    fast: routeLike?.fast === true,
  };
}

function agentPresetName(agent) {
  return `AGENT ${String(agent || '').toUpperCase()}`;
}

async function resolvePrompt(args, cwd) {
  const prompt = clean(args.prompt || args.message);
  const file = clean(args.file);
  if (prompt && file) throw new Error('agent: provide only one of prompt/message or file');
  if (prompt) return prompt;
  if (file) {
    const target = isAbsolute(file) ? file : resolve(cwd || process.cwd(), file);
    return readFileSync(target, 'utf8');
  }
  throw new Error('agent: prompt/message/file is required');
}

function withCwdHeader(prompt, cwd) {
  if (!cwd) return prompt;
  if (String(prompt).startsWith('[effective-cwd]')) return prompt;
  return `[effective-cwd] ${cwd}\n\n${prompt}`;
}

function oneLine(value, max = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactIso(value) {
  const text = clean(value);
  if (!text) return '';
  return text.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function formatElapsedMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  const totalSec = Math.floor(n / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h${remMin}m` : `${hr}h`;
}

function elapsedFromStamps(startedAt, finishedAt, status) {
  const start = Date.parse(clean(startedAt));
  if (!Number.isFinite(start)) return null;
  const finish = Date.parse(clean(finishedAt));
  const end = Number.isFinite(finish) ? finish : Date.now();
  const label = formatElapsedMs(end - start);
  if (!label) return null;
  return Number.isFinite(finish) ? label : `${label} (running)`;
}

function stripFinalAnswerWrapper(value) {
  const text = String(value ?? '').trim();
  const match = /^<final-answer\b[^>]*>([\s\S]*?)<\/final-answer>\s*$/i.exec(text);
  return match ? match[1].trim() : text;
}

function renderResult(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const lines = [];

    if (Array.isArray(value.workers) || Array.isArray(value.jobs)) {
      const workers = Array.isArray(value.workers) ? value.workers : [];
      lines.push(`agents: ${workers.length}`);
      for (const worker of workers) {
        const tokens = worker.windowTokens ? ` ctx=${worker.windowTokens}${worker.windowCap ? `/${worker.windowCap}` : ''}` : '';
        const terminal = worker.clientHostPid ? ` term=${worker.clientHostPid}` : '';
        const base = `- ${worker.tag} ${worker.agent || 'agent'} ${worker.status || 'idle'}/${worker.worker_stage || worker.stage || 'idle'} ${worker.provider}/${worker.model}${terminal}${tokens}`;
        lines.push(appendAgentProgressKv(base, worker));
      }
      const jobs = Array.isArray(value.jobs) ? value.jobs : [];
      lines.push(`tasks: ${jobs.length}`);
      for (const job of jobs) {
        const target = job.tag || job.sessionId || '-';
        const terminal = job.clientHostPid ? ` term=${job.clientHostPid}` : '';
        const base = `- ${job.task_id} ${job.type} ${job.status} target=${target}${terminal}${job.error ? ` error=${presentErrorText(job.error, { surface: 'agent' })}` : ''}`;
        lines.push(appendAgentProgressKv(base, job));
      }
      if (workers.length === 0 && jobs.length === 0) lines.push('(no agents or tasks)');
      return lines.join('\n');
    }

    if (value.task_id) {
      lines.push(`agent task: ${value.task_id}`);
      lines.push(`status: ${value.status}`);
      if (value.type) lines.push(`type: ${value.type}`);
      if (value.reused) lines.push('reused: true');
      if (value.tag || value.sessionId) lines.push(`target: ${value.tag || '-'} ${value.sessionId || ''}`.trim());
      if (value.agent) lines.push(`agent: ${value.agent}`);
      if (value.provider && value.model) lines.push(`model: ${value.provider}/${value.model}`);
      if (value.effort) lines.push(`effort: ${value.effort}`);
      if (value.fast === true || value.fast === false) lines.push(`fast: ${value.fast ? 'on' : 'off'}`);
      if (value.maxLoopIterations) {
        const limitParts = [];
        if (value.maxLoopIterations) limitParts.push(`loop=${value.maxLoopIterations}`);
        lines.push(`limits: ${limitParts.join(' ')}`);
      }
      if (value.stage || value.workerStatus) lines.push(`worker: ${value.workerStatus || 'unknown'}/${value.stage || 'unknown'}`);
      if (value.worker_stage) lines.push(`worker_stage: ${value.worker_stage}`);
      if (value.last_progress) lines.push(`last_progress: ${value.last_progress}`);
      if (Number.isFinite(value.silent_for)) lines.push(`silent_for: ${value.silent_for}s`);
      if (value.watchdog) lines.push(`watchdog: ${value.watchdog}`);
      if (Number.isFinite(value.queued_followups)) lines.push(`queued_followups: ${value.queued_followups}`);
      if (value.diagnostic) lines.push(`diagnostic: ${value.diagnostic}`);
      if (value.startedAt) lines.push(`started: ${compactIso(value.startedAt)}`);
      if (value.finishedAt) lines.push(`finished: ${compactIso(value.finishedAt)}`);
      {
        const elapsed = elapsedFromStamps(value.startedAt, value.finishedAt, value.status);
        if (elapsed) lines.push(`elapsed: ${elapsed}`);
      }
      if (value.error) lines.push(`error: ${presentErrorText(value.error, { surface: 'agent' })}`);
      if (value.status === 'running') lines.push('notification: completion will be delivered to the owner session; use read/status only for manual recovery.');
      if (value.result !== undefined) {
        const result = value.result;
        const content = typeof result === 'string' ? result : result?.content;
        if (content) lines.push('', stripFinalAnswerWrapper(content));
        else lines.push('', JSON.stringify(result, null, 2));
      }
      return lines.join('\n');
    }

    if (value.queued) {
      return [
        'agent message queued',
        value.reused ? 'reused: true' : null,
        `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
        value.agent ? `agent: ${value.agent}` : null,
        `queueDepth: ${value.queueDepth ?? 1}`,
      ].filter(Boolean).join('\n');
    }

    if (value.closed !== undefined) {
      return [
        `agent close: ${value.closed ? 'ok' : 'not closed'}`,
        value.tag ? `tag: ${value.tag}` : null,
        value.sessionId ? `sessionId: ${value.sessionId}` : null,
        value.task_id ? `task_id: ${value.task_id}` : null,
        value.forgotten ? 'forgotten: true' : null,
      ].filter(Boolean).join('\n');
    }

    if (value.content !== undefined) {
      const header = [
        value.respawned ? 'agent respawned' : 'agent result',
        value.tag ? `tag=${value.tag}` : null,
        value.agent ? `agent=${value.agent}` : null,
        value.provider && value.model ? `${value.provider}/${value.model}` : null,
      ].filter(Boolean).join(' ');
      return `${header}\n${stripFinalAnswerWrapper(value.content)}`;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: defaultCwd }) {
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
    return Date.now() - t < TERMINAL_REAP_MS;
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

  function scheduleReap(sessionId) {
    if (!sessionId) return;
    cancelReap(sessionId);
    const handle = setTimeout(() => {
      reapTimers.delete(sessionId);
      try { mgr.hideSessionFromList?.(sessionId); } catch {}
      const tag = tagForSession(sessionId);
      if (tag) forgetTag(tag);
      removeWorkerRow({ tag, sessionId });
      clearAgentStatuslineRoute(sessionId);
      try { mgr.closeSession(sessionId, 'terminal-reap'); } catch {}
    }, TERMINAL_REAP_MS);
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

  // Provider init de-dup. Four goals that must not conflict:
  //   (a) a parallel spawn fanout that all targets the SAME provider with the
  //       SAME effective config performs at most ONE initProviders() pass
  //       instead of N serially-awaited registry rebuilds,
  //   (b) a provider CONFIG CHANGE still reaches initProviders() so the
  //       registry's own signature guard can re-initialize it,
  //   (c) two DIFFERENT config signatures for the same provider never init
  //       concurrently — otherwise a slow init of the OLD config could land
  //       after a fast init of the NEW config and revert the live registry to
  //       stale config, and
  //   (d) a SUPERSEDED request never resolves before the provider is actually
  //       ready: even when its own (stale) init is dropped to satisfy (c), the
  //       caller (a spawn about to run prepareSpawn) must still WAIT for the
  //       latest init to finish, or it would proceed against an unprepared /
  //       stale provider.
  //
  // Skip cache + in-flight collapse are keyed on `provider + signature(effective
  // config)`. To satisfy (c) we SERIALIZE all inits per provider on a chain
  // promise and re-check the latest-requested signature inside the chain: a
  // request superseded by a newer signature drops its own init. To satisfy (d)
  // such a dropped request does not resolve immediately — it awaits the
  // provider's latest settled init (tracked as a rolling "ready" promise) so the
  // caller only proceeds once the newest config is live.
  // Per-provider state. `chain` serializes the ACTUAL initProviders() calls so
  // two different config signatures never run concurrently (goal c). `latestGen`
  // / `latestSig` track the newest requested config. `ready` is a rolling
  // deferred that resolves only when the LATEST requested init has completed —
  // a superseded caller awaits the ready deferred captured at call time, and
  // when a newer request arrives the older deferred ADOPTS the newer one, so a
  // superseded caller transitively waits for the latest init (goal d).
  const _providerState = new Map(); // provider -> state
  const _providerInitPending = new Map(); // provider -> { sigKey, promise } identical-sig collapse
  // Upper bound on how long a queued init waits for the PRIOR chain link before
  // proceeding anyway. A prior init that HANGS (never settles) must not poison
  // the chain and wedge every later request behind it. A hung init can never
  // *complete* against the registry, so it cannot land-after and clobber a
  // newer config (goal c only fears slow-but-completing inits) — so proceeding
  // once the gate expires is safe. Defaults to the spawn-prep cap; 0 disables.
  const PROVIDER_CHAIN_GATE_MS = DEFAULT_SPAWN_PREP_TIMEOUT_MS;
  function providerRegistered(provider) {
    return typeof reg.getProvider !== 'function' || Boolean(reg.getProvider(provider));
  }
  function effectiveProviderConfig(config, provider) {
    const providers = { ...(config.providers || {}) };
    providers[provider] = { ...(providers[provider] || {}), enabled: true };
    return providers;
  }
  function providerStateFor(provider) {
    let s = _providerState.get(provider);
    if (!s) {
      s = { chain: Promise.resolve(), completedSig: null, latestSig: null, latestGen: 0, ready: null };
      _providerState.set(provider, s);
    }
    return s;
  }
  function providerInitSignature(provider, effectiveProviders) {
    let body;
    try { body = JSON.stringify(effectiveProviders); }
    catch { body = String(Date.now()); } // unserializable → force a fresh init
    return `${provider}\u0000${body}`;
  }
  function gateOnPrior(prior) {
    const settled = Promise.resolve(prior).catch(() => {});
    if (!(PROVIDER_CHAIN_GATE_MS > 0)) return settled;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, PROVIDER_CHAIN_GATE_MS);
      timer.unref?.();
      settled.then(() => { clearTimeout(timer); finish(); }, () => { clearTimeout(timer); finish(); });
    });
  }
  function ensureProvider(config, provider) {
    const effective = effectiveProviderConfig(config, provider);
    const sigKey = providerInitSignature(provider, effective);
    const registered = () => providerRegistered(provider);
    const s = providerStateFor(provider);
    // Completed-skip: this exact effective config is already live for this
    // provider. A config change flips sigKey so we fall through; a torn-down
    // provider (no longer registered) also does.
    if (s.completedSig === sigKey && registered()) return Promise.resolve();
    // Identical-sig collapse: a request with the SAME sigKey is already in
    // flight — share its caller promise.
    const pending = _providerInitPending.get(provider);
    if (pending && pending.sigKey === sigKey) return pending.promise;
    // New generation. Repoint the rolling `ready` deferred to THIS gen and make
    // the previous gen's deferred ADOPT the new one, so any superseded caller
    // awaiting an older deferred transitively waits for the newest init (d).
    const gen = ++s.latestGen;
    s.latestSig = sigKey;
    const prevReady = s.ready;
    let resolveReady;
    const readyPromise = new Promise((r) => { resolveReady = r; });
    s.ready = { gen, promise: readyPromise, resolve: resolveReady };
    if (prevReady && prevReady.gen < gen) {
      try { prevReady.resolve(readyPromise); } catch { /* already settled */ }
    }
    // Serialize the ACTUAL init behind the prior chain link (gated so a hung
    // prior cannot wedge the chain). A superseded gen's chain link settles
    // quickly — it never awaits a later gen — so there is no deadlock.
    const prior = s.chain;
    const chainLink = gateOnPrior(prior).then(async () => {
      if (s.latestGen !== gen) {
        // Superseded before we ran: drop our (stale) init entirely (goal c).
        // Our `ready` deferred already adopts the newer gen, so the caller below
        // still waits for the latest init. Settle now to release the chain.
        return;
      }
      try {
        if (!(s.completedSig === sigKey && registered())) {
          await reg.initProviders(effective);
          s.completedSig = sigKey;
        }
      } finally {
        // ALWAYS release this gen's waiters once we are the latest — even on a
        // registry init failure. Adopting (superseded) callers chained onto this
        // deferred would otherwise hang forever; instead they proceed and their
        // own createSession()/prep-timeout surfaces the unprepared provider.
        resolveReady();
      }
    });
    // Next chain link waits on us (settled, never poisoned).
    s.chain = chainLink.catch(() => {});
    // The CALLER awaits the ready deferred (resolves only when the LATEST init
    // for this provider completes), not just the chain link — so a superseded
    // caller blocks until the newest config is live (goal d). chainLink is
    // awaited first so a registry init error surfaces to this caller.
    const callerPromise = chainLink.then(() => readyPromise).finally(() => {
      const cur = _providerInitPending.get(provider);
      if (cur && cur.promise === callerPromise) _providerInitPending.delete(provider);
    });
    _providerInitPending.set(provider, { sigKey, promise: callerPromise });
    return callerPromise;
  }

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
    const agentRoute = !clean(args.preset)
      ? (normalizeAgentRoute(config?.agents?.[agentName])
        || (agentName === 'maintainer' ? normalizeAgentRoute(config?.agents?.maintenance) : null))
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
    if (!taskId) throw new Error('agent read/status: task_id is required');
    const task = getBackgroundTask(taskId, { surface: 'agent', context });
    if (!task) throw new Error(`agent read/status: task "${taskId}" not found`);
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

  function enqueueCompletionMessage(sessionId, text, meta = {}) {
    const target = clean(sessionId);
    if (!target || typeof mgr.enqueuePendingMessage !== 'function') return false;
    try {
      const visible = modelVisibleToolCompletionMessage(text, meta);
      return Boolean(visible && mgr.enqueuePendingMessage(target, visible) > 0);
    } catch {
      return false;
    }
  }

  // Wire the canonical completion fallback to this agent surface's owner-session
  // enqueue so notifyTaskCompletion can deliver via callerSessionId when no
  // notifyFn is present or it declines. Registered once per agent (the closure
  // captures mgr); signatures align: (callerSessionId, message, meta).
  setBackgroundTaskEnqueueFallback((sessionId, text, meta) => enqueueCompletionMessage(sessionId, text, meta));

  function workerNotifyFn(workerSessionId, notifyContext = {}) {
    const workerId = clean(workerSessionId);
    const ownerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const upstream = typeof notifyContext?.notifyFn === 'function' ? notifyContext.notifyFn : null;
    return (text, meta = {}) => {
      let ownerDelivered = false;
      if (upstream) {
        try {
          const result = upstream(text, meta);
          ownerDelivered = result !== false;
          if (ownerDelivered) Promise.resolve(result).catch(() => {});
        } catch {
          ownerDelivered = false;
        }
      }
      if (!ownerDelivered && ownerSessionId) {
        ownerDelivered = enqueueCompletionMessage(ownerSessionId, text, meta);
      }
      const workerDelivered = workerId && workerId !== ownerSessionId
        ? enqueueCompletionMessage(workerId, text, meta)
        : ownerDelivered;
      return ownerSessionId ? ownerDelivered : workerDelivered;
    };
  }

  function notifyOwnerAgentCompletionEarly(job, resultValue, notifyContext = {}) {
    if (!job || job._earlyCompletionNotified === true) return false;
    const ownerSessionId = clean(notifyContext?.callerSessionId || notifyContext?.sessionId);
    const upstream = typeof notifyContext?.notifyFn === 'function' ? notifyContext.notifyFn : null;
    const finishedAt = new Date().toISOString();
    const snapshot = {
      ...job,
      status: 'completed',
      finishedAt,
      finishedAtMs: Date.now(),
      result: resultValue,
      resultType: job.resultType || 'agent_task_result',
      meta: sanitizeTaskMeta(job.meta || {}),
    };
    // An early notification is only a header-only *preview*: it fires before
    // the worker's session is persisted to signal the running→completed
    // transition. It deliberately carries NO result body — the canonical
    // notifyTaskCompletion delivers the body exactly once via the
    // reconcile/finally path, so omitting it here keeps notifications
    // exact-once with no duplicate body.
    const text = renderBackgroundTask(snapshot, { includeResult: false });
    const meta = {
      type: snapshot.resultType,
      execution_surface: 'agent',
      execution_id: job.taskId || null,
      status: 'completed',
      instruction: `The async agent task ${job.taskId || ''} has finished (completed) - review this result in your next step.`,
      ...(ownerSessionId ? { caller_session_id: ownerSessionId } : {}),
    };
    let delivered = false;
    if (upstream) {
      try {
        const result = upstream(text, meta);
        delivered = result !== false;
        if (delivered) Promise.resolve(result).catch(() => {});
      } catch {
        delivered = false;
      }
    }
    if (!delivered && ownerSessionId) {
      delivered = enqueueCompletionMessage(ownerSessionId, text, meta);
    }
    if (delivered) {
      // Mark only that a header-only preview fired. The canonical
      // notifyTaskCompletion still owns the single body-carrying notification.
      job._earlyCompletionNotified = true;
    }
    return delivered;
  }

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

  function startProgressIdleWatchdog(sessionId, watchdogPolicy) {
    if (!sessionId || !agentWatchdogPolicyActive(watchdogPolicy)) return null;
    if (typeof mgr.getSessionProgressSnapshot !== 'function' && typeof mgr.getSessionLastProgressAt !== 'function') return null;
    if (typeof mgr.linkParentSignalToSession !== 'function') return null;
    const controller = new AbortController();
    try { mgr.linkParentSignalToSession(sessionId, controller.signal); } catch { return null; }
    const timer = setInterval(() => {
      const now = Date.now();
      const snapshot = typeof mgr.getSessionProgressSnapshot === 'function'
        ? mgr.getSessionProgressSnapshot(sessionId)
        : null;
      const abortErr = snapshot
        ? evaluateAgentWatchdogAbort(snapshot, now, watchdogPolicy)
        : null;
      if (!abortErr && !snapshot) {
        const last = mgr.getSessionLastProgressAt(sessionId);
        if (watchdogPolicy.idleStaleMs > 0 && last && now - last > watchdogPolicy.idleStaleMs) {
          try { controller.abort(new Error(`agent task stale (${watchdogPolicy.idleStaleMs}ms without progress)`)); } catch {}
        }
        return;
      }
      if (abortErr) {
        try { controller.abort(abortErr); } catch {}
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
    const agentPermission = readAgentFrontmatterPermission(agent, dataDir);
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
    const watchdog = startProgressIdleWatchdog(session.id, watchdogPolicy);
    let finalStatus = 'idle';
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
    try {
      const completionValue = (result) => ({
        tag,
        sessionId: session.id,
        agent,
        preset: presetKey(preset) || presetName,
        provider: preset.provider,
        model: preset.model,
        effort: preset.effort || null,
        fast: preset.fast === true,
        content: result?.content || '',
      });
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
                reconcileBackgroundTask(job.taskId, {
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
      return completionValue(result);
    } catch (error) {
      finalStatus = 'error';
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
            terminalReason: 'agent-finally-reconcile',
          });
        } catch {}
      }
      scheduleReap(session.id);
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
    const watchdog = startProgressIdleWatchdog(sessionId, resolveAgentWatchdogPolicy(sendAgent));
    const tag = tagForSession(sessionId);
    let finalStatus = 'idle';
    upsertWorkerSessionDeferred(session, tag, { status: 'running', stage: 'running' });
    try {
      const completionValue = (result) => ({
        tag,
        sessionId,
        agent: session.agent || null,
        provider: session.provider,
        model: session.model,
        content: result?.content || '',
      });
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
                reconcileBackgroundTask(job.taskId, {
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
      return completionValue(result);
    } catch (error) {
      finalStatus = 'error';
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
  function hasTerminalTrace(tag, context = {}) {
    const value = clean(tag);
    if (!value || value.startsWith('sess_')) return false;
    if (resolveTag(value, context, { excludeTerminalTraces: true })) return false; // live -> reuse, not trace
    if (tagAgents.has(value)) return true;
    return readWorkerRows(context).some((row) => clean(row.tag) === value);
  }

  function terminalTraceSpawnError(tag) {
    return new Error(`agent spawn: tag "${tag}" refers to a finished or closed worker; wait for reap or use a new tag`);
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
        const prepared = await prepareSend(args, scopedContext);
        return dispatchToExistingSession(prepared, notifyContext);
      }
      if (type === 'spawn') {
        // Explicit-tag spawn priority (auto nextTag always creates a fresh session):
        //   1) live + busy -> queue the prompt (reuse)
        //   2) live + idle -> continue existing session (reuse)
        //   3) lingering terminal trace -> error (no defensive respawn)
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
            throw terminalTraceSpawnError(explicitTag);
          }
        }
        const job = startDeferredSpawnJob(args, callerCwd, context, notifyContext);
        return renderResult(renderJob(job, false));
      }
      throw new Error(`agent: unknown type "${type}"`);
    } catch (err) {
      return `Error: ${presentErrorText(err, { surface: 'agent' })}`;
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