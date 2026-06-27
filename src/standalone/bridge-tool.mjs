import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
  resolveExecutionMode,
  startBackgroundTask,
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
import { prepareBridgeSession } from '../runtime/agent/orchestrator/smart-bridge/session-builder.mjs';
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
  'heavy-worker': 'opus-high',
  reviewer: 'opus-xhigh',
  debugger: 'opus-xhigh',
});

export const BRIDGE_TOOL = {
  name: 'agent',
  title: 'Agent',
  annotations: {
    title: 'Agent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    bridgeHidden: true,
  },
  description: `Delegate scoped work to workflow agents. Always use mode:"async" for model handoffs; never use mode:"sync". Spawn independent agents in parallel with distinct tags, then keep doing Lead-side work that does not need their result. If the result is needed before continuing, pause the dependent path and wait for the async completion notification. Do not poll status/read or interfere after spawn; status/read are manual recovery or explicit user-requested controls only. ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Action. Default spawn; send follows up to an existing tag/session. status/read are manual recovery controls, not normal polling.' },
      mode: { type: 'string', enum: ['async'], description: `Always use mode:"async". ${TOOL_ASYNC_EXECUTION_CONTRACT}` },
      task_id: { type: 'string', description: 'Manual status/read/cancel recovery task ID; not needed for normal async completion.' },
      agent: { type: 'string', description: 'Workflow agent id to run.' },
      tag: { type: 'string', description: 'Stable agent handle; distinct tag per parallel agent.' },
      sessionId: { type: 'string', description: 'Raw sess_ id.' },
      prompt: { type: 'string', description: 'Scoped task brief: anchors, constraints, done condition.' },
      message: { type: 'string', description: 'Follow-up for send, or spawn brief.' },
      file: { type: 'string', description: 'Prompt file.' },
      cwd: { type: 'string', description: 'Working directory.' },
      context: { type: 'string', description: 'Extra agent context.' },
      firstResponseTimeoutMs: { type: 'number', minimum: 0, description: 'Abort only when the agent produces no first stream/tool activity within this many ms. Default 120s. 0 disables this watchdog.' },
      idleTimeoutMs: { type: 'number', minimum: 0, description: 'Stale watchdog after first stream/tool activity. Default 30m. 0 disables stale abort.' },
    },
    additionalProperties: true,
  },
};

const TERMINAL_REAP_MS = 60 * 60_000;
const WORKER_INDEX_FILE = 'agent-workers.json';
const LEGACY_WORKER_INDEX_FILE = 'bridge-workers.json';
function envTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = envTimeoutMs('MIXDOG_BRIDGE_FIRST_RESPONSE_TIMEOUT_MS', 120_000);
const DEFAULT_STALE_TIMEOUT_MS = envTimeoutMs('MIXDOG_BRIDGE_STALE_TIMEOUT_MS', 30 * 60_000);
const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);

function clean(value) {
  return String(value ?? '').trim();
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

export function resolveBridgeExecutionMode(args = {}, context = {}, defaultMode = 'async') {
  const fallback = context.invocationSource !== 'user-command' ? 'async' : defaultMode;
  return resolveExecutionMode(args, fallback);
}

function readAgentFrontmatterPermission(role, dataDir) {
  const cleanRole = clean(role);
  if (!cleanRole) return null;
  const candidates = [];
  if (dataDir) {
    candidates.push(join(dataDir, 'agents', cleanRole, 'AGENT.md'));
    candidates.push(join(dataDir, 'agents', `${cleanRole}.md`));
  }
  candidates.push(join(STANDALONE_SOURCE_ROOT, 'agents', cleanRole, 'AGENT.md'));
  candidates.push(join(STANDALONE_SOURCE_ROOT, 'agents', `${cleanRole}.md`));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const fm = parseMarkdownFrontmatter(readFileSync(file, 'utf8'));
    const permission = normalizeAgentPermissionOrNone(fm.permission);
    if (permission) return permission;
  }
  return null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function terminalPidForContext(context = {}) {
  return positiveInt(context?.clientHostPid);
}

function bridgeScope(args = {}, context = {}) {
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

function resolveWatchdogMs(value, fallback) {
  const explicit = nonNegativeInt(value);
  if (explicit !== null) return explicit;
  return nonNegativeInt(fallback) ?? 0;
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

function writeBridgeStatuslineRoute(sessionId, preset) {
  const route = bridgeRouteForStatusline(preset);
  if (!sessionId || !route) return false;
  try { return writeGatewaySessionRoute(sessionId, route); } catch { return false; }
}

function clearBridgeStatuslineRoute(sessionId) {
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

function agentPresetName(role) {
  return `AGENT ${String(role || '').toUpperCase()}`;
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
      lines.push(`agent mode: ${value.bridgeMode || 'async'}`);
      const workers = Array.isArray(value.workers) ? value.workers : [];
      lines.push(`agents: ${workers.length}`);
      for (const worker of workers) {
        const stale = Number.isFinite(worker.staleSeconds) ? ` stale=${worker.staleSeconds}s` : '';
        const tokens = worker.windowTokens ? ` ctx=${worker.windowTokens}${worker.windowCap ? `/${worker.windowCap}` : ''}` : '';
        const terminal = worker.clientHostPid ? ` term=${worker.clientHostPid}` : '';
        lines.push(`- ${worker.tag} ${worker.role || 'agent'} ${worker.status || 'idle'}/${worker.stage || 'idle'} ${worker.provider}/${worker.model}${terminal}${stale}${tokens}`);
      }
      const jobs = Array.isArray(value.jobs) ? value.jobs : [];
      lines.push(`tasks: ${jobs.length}`);
      for (const job of jobs) {
        const target = job.tag || job.sessionId || '-';
        const terminal = job.clientHostPid ? ` term=${job.clientHostPid}` : '';
        lines.push(`- ${job.task_id} ${job.type} ${job.status} target=${target}${terminal}${job.error ? ` error=${presentErrorText(job.error, { surface: 'agent' })}` : ''}`);
      }
      if (workers.length === 0 && jobs.length === 0) lines.push('(no agents or tasks)');
      return lines.join('\n');
    }

    if (value.task_id) {
      lines.push(`agent task: ${value.task_id}`);
      lines.push(`status: ${value.status}${value.mode ? ` (${value.mode})` : ''}`);
      if (value.type) lines.push(`type: ${value.type}`);
      if (value.tag || value.sessionId) lines.push(`target: ${value.tag || '-'} ${value.sessionId || ''}`.trim());
      if (value.role) lines.push(`agent: ${value.role}`);
      if (value.provider && value.model) lines.push(`model: ${value.provider}/${value.model}`);
      if (value.effort) lines.push(`effort: ${value.effort}`);
      if (value.fast === true || value.fast === false) lines.push(`fast: ${value.fast ? 'on' : 'off'}`);
      if (value.maxLoopIterations || value.idleTimeoutMs || value.firstResponseTimeoutMs) {
        const limitParts = [];
        if (value.maxLoopIterations) limitParts.push(`loop=${value.maxLoopIterations}`);
        if (value.firstResponseTimeoutMs) limitParts.push(`first=${Math.round(value.firstResponseTimeoutMs / 1000)}s`);
        if (value.idleTimeoutMs) limitParts.push(`stale=${Math.round(value.idleTimeoutMs / 1000)}s`);
        lines.push(`limits: ${limitParts.join(' ')}`);
      }
      if (value.stage || value.workerStatus) lines.push(`agent: ${value.workerStatus || 'unknown'}/${value.stage || 'unknown'}`);
      if (value.startedAt) lines.push(`started: ${compactIso(value.startedAt)}`);
      if (value.finishedAt) lines.push(`finished: ${compactIso(value.finishedAt)}`);
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
        `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
        value.role ? `agent: ${value.role}` : null,
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
        value.role ? `agent=${value.role}` : null,
        value.provider && value.model ? `${value.provider}/${value.model}` : null,
      ].filter(Boolean).join(' ');
      return `${header}\n${stripFinalAnswerWrapper(value.content)}`;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function createStandaloneBridge({ cfgMod, reg, mgr, dataDir, cwd: defaultCwd, defaultMode: initialMode }) {
  const tags = new Map();
  const tagRoles = new Map();
  const tagCwds = new Map();
  const reapTimers = new Map();
  let tagSeq = 0;
  // Inline normalization here (normalizeMode is defined below — avoid
  // use-before-def). When nothing is injected, the Lead defaults to async.
  let defaultMode = (String(initialMode ?? 'async').toLowerCase() === 'async') ? 'async' : 'sync';

  function normalizeMode(value) {
    const mode = clean(value).toLowerCase();
    return mode === 'async' ? 'async' : 'sync';
  }

  function modeFor(args = {}, context = {}) {
    return resolveBridgeExecutionMode(args, context, defaultMode);
  }

  function workerIndexPath() {
    return dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  }

  function legacyWorkerIndexPath() {
    return dataDir ? resolve(dataDir, LEGACY_WORKER_INDEX_FILE) : null;
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
        role: clean(row.role) || null,
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

  function readWorkerRows(context = {}) {
    const file = workerIndexPath();
    const legacyFile = legacyWorkerIndexPath();
    const sourceFile = file && existsSync(file) ? file : (legacyFile && existsSync(legacyFile) ? legacyFile : null);
    if (!sourceFile) return [];
    try {
      const rows = normalizeWorkerRows(JSON.parse(readFileSync(sourceFile, 'utf8')));
      return rows.filter((row) => rowMatchesContext(row, context));
    } catch {
      return [];
    }
  }

  function workerRowsForUpdate(cur) {
    const rows = normalizeWorkerRows(cur);
    if (rows.length > 0) return rows;
    const legacyFile = legacyWorkerIndexPath();
    if (!legacyFile || !existsSync(legacyFile)) return rows;
    try { return normalizeWorkerRows(JSON.parse(readFileSync(legacyFile, 'utf8'))); }
    catch { return rows; }
  }

  function writeWorkerRows(mutator) {
    const file = workerIndexPath();
    if (!file || typeof mutator !== 'function') return null;
    try {
      return updateJsonAtomicSync(file, (cur) => {
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
    } catch {
      return null;
    }
  }

  function workerRowFromSession(session, fallbackTag = '', extra = {}) {
    const tag = clean(session?.bridgeTag) || clean(fallbackTag) || clean(extra.tag);
    const sessionId = clean(session?.id || extra.sessionId);
    if (!tag || !sessionId) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = clean(extra.status) || (session?.closed === true ? 'closed' : clean(session?.status) || 'idle');
    const stage = clean(extra.stage) || clean(runtime?.stage) || status;
    const nowIso = new Date().toISOString();
    return {
      tag,
      sessionId,
      role: clean(extra.role) || clean(session?.role) || null,
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
      bridgeTag: row.tag,
      role: row.role || null,
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

  function upsertWorkerRow(row) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    tags.set(normalized.tag, normalized.sessionId);
    if (normalized.role) tagRoles.set(normalized.tag, normalized.role);
    if (normalized.cwd) tagCwds.set(normalized.tag, normalized.cwd);
    writeWorkerRows((byKey) => {
      const key = workerRowKey(normalized);
      const prev = byKey.get(key) || {};
      const merged = { ...prev, ...normalized };
      for (const field of ['role', 'provider', 'model', 'preset', 'effort', 'fast', 'clientHostPid', 'cwd', 'task_id', 'permission', 'toolPermission']) {
        if ((merged[field] === null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
          merged[field] = prev[field];
        }
      }
      byKey.set(key, {
        ...merged,
        createdAt: normalized.createdAt || prev.createdAt || new Date().toISOString(),
        updatedAt: normalized.updatedAt || new Date().toISOString(),
      });
    });
    return true;
  }

  function upsertWorkerSession(session, fallbackTag = '', extra = {}) {
    return upsertWorkerRow(workerRowFromSession(session, fallbackTag, extra));
  }

  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
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
      if (row.role) tagRoles.set(row.tag, row.role);
      if (row.cwd) tagCwds.set(row.tag, row.cwd);
    }
    return rows;
  }

  function wantsSessionScan(args = {}) {
    return args.recover === true || args.scanSessions === true || args.scan_sessions === true;
  }

  function resolveTag(target, context = {}, options = {}) {
    const scanSessions = options.scanSessions === true;
    refreshTagsFromSessions({ scanSessions, context });
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) {
      const session = getLiveSession(value);
      if (session && sessionMatchesContext(session, context)) return value;
      const row = readWorkerRows(context).find((item) => item.sessionId === value);
      return row ? value : null;
    }
    const matches = bridgeSessionEntries({ scanSessions, context })
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
    const persistedTag = clean(session?.bridgeTag);
    if (persistedTag) return persistedTag;
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  function bridgeSessionEntries({ scanSessions = false, context = {} } = {}) {
    const rows = [];
    const seen = new Set();
    const add = (session, fallbackTag = '') => {
      const tag = clean(session?.bridgeTag) || clean(fallbackTag);
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
      seen.add(sessionId);
      rows.push({ tag, session: workerRowToSession(row), indexRow: row });
    };
    for (const row of readWorkerRows(context)) addIndexRow(row);
    if (scanSessions) {
      for (const session of mgr.listSessions({ includeClosed: false }) || []) {
        add(session, session?.bridgeTag);
        if (clean(session?.bridgeTag)) upsertWorkerSession(session, session.bridgeTag);
      }
    }
    for (const [tag, sessionId] of tags.entries()) {
      add(getLiveSession(sessionId), tag);
    }
    return rows;
  }

  function nextTag(role, context = {}) {
    refreshTagsFromSessions({ context });
    let tag;
    do {
      tag = `${clean(role) || 'agent'}${++tagSeq}`;
    } while (resolveTag(tag, context));
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
      const tag = clean(session?.bridgeTag);
      if (!tag || tags.has(tag)) continue;
      if (!sessionMatchesContext(session, context)) continue;
      tags.set(tag, session.id);
      if (session.role) tagRoles.set(tag, session.role);
      if (session.cwd) tagCwds.set(tag, session.cwd);
      upsertWorkerSession(session, tag);
    }
  }

  function bindTag(tag, session, extra = {}) {
    if (!tag || !session?.id) return;
    tags.set(tag, session.id);
    if (session.role) tagRoles.set(tag, session.role);
    if (session.cwd) tagCwds.set(tag, session.cwd);
    upsertWorkerSession(session, tag, extra);
  }

  function forgetTag(tag) {
    if (!tag) return;
    const sessionId = tags.get(tag) || '';
    tags.delete(tag);
    tagRoles.delete(tag);
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
      clearBridgeStatuslineRoute(sessionId);
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

  async function ensureProvider(config, provider) {
    const providers = { ...(config.providers || {}) };
    providers[provider] = { ...(providers[provider] || {}), enabled: true };
    await reg.initProviders(providers);
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

    const agentName = normalizeAgentName(args.agent || args.role);
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
    for (const { tag, session } of bridgeSessionEntries({ scanSessions, context })) {
      const sessionId = session.id;
      const runtime = mgr.getSessionRuntime?.(sessionId);
      const status = session.closed === true ? 'closed' : (session.status || 'idle');
      const stage = session.stage || (status === 'idle' || status === 'error' || status === 'closed'
        ? status
        : (runtime?.stage || status));
      rows.push({
        tag,
        sessionId,
        role: session.role || null,
        provider: session.provider,
        model: session.model,
        preset: session.presetName || null,
        effort: session.effort || null,
        fast: session.fast === true,
        status,
        stage,
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

  function jobWorkerSnapshot(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    if (!session) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = session.closed === true ? 'closed' : (session.status || 'idle');
    return {
      workerStatus: status,
      stage: runtime?.stage || status,
      clientHostPid: session.clientHostPid || null,
      lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
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
      role: task.role || null,
      preset: task.preset || null,
      provider: task.provider || null,
      model: task.model || null,
      effort: task.effort || null,
      fast: task.fast === true || task.fast === false ? task.fast : null,
      maxLoopIterations: task.maxLoopIterations || null,
      idleTimeoutMs: task.idleTimeoutMs || null,
      firstResponseTimeoutMs: task.firstResponseTimeoutMs || null,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt || null,
      error: task.error || null,
      ...jobWorkerSnapshot(task.sessionId),
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
    return {
      task_id: job.taskId,
      type: job.operation,
      status: job.status,
      tag: meta.tag || null,
      sessionId: meta.sessionId || null,
      role: meta.role || null,
      preset: meta.preset || null,
      provider: meta.provider || null,
      model: meta.model || null,
      effort: meta.effort || null,
      fast: meta.fast === true || meta.fast === false ? meta.fast : null,
      maxLoopIterations: meta.maxLoopIterations || null,
      idleTimeoutMs: meta.idleTimeoutMs || null,
      firstResponseTimeoutMs: meta.firstResponseTimeoutMs || null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      ...jobWorkerSnapshot(meta.sessionId),
      ...(includeResult && job.result !== undefined ? { result: job.result } : {}),
    };
  }

  function preparedSpawnMeta(prepared, extras = {}) {
    return {
      ...(extras || {}),
      tag: prepared.tag,
      sessionId: prepared.session.id,
      role: prepared.role,
      preset: presetKey(prepared.preset) || prepared.presetName,
      provider: prepared.preset.provider,
      model: prepared.preset.model,
      effort: prepared.preset.effort || null,
      fast: prepared.preset.fast === true,
      maxLoopIterations: prepared.maxLoopIterations || null,
      idleTimeoutMs: prepared.idleTimeoutMs || null,
      firstResponseTimeoutMs: prepared.firstResponseTimeoutMs || null,
    };
  }

  function pendingSpawnMeta(args = {}, extras = {}) {
    const role = normalizeAgentName(args.agent || args.role);
    return {
      ...(extras || {}),
      tag: clean(args.tag) || null,
      sessionId: null,
      role: role || null,
      preset: clean(args.preset) || null,
      provider: clean(args.provider) || null,
      model: clean(args.model) || null,
      effort: clean(args.effort) || null,
      fast: args.fast === true ? true : null,
    };
  }

  function mergeJobMeta(job, meta = {}) {
    if (!job || !meta || typeof meta !== 'object') return;
    const next = { ...(job.meta || {}), ...meta };
    job.meta = next;
    if (job.input && typeof job.input === 'object') {
      job.input = {
        ...job.input,
        tag: next.tag || job.input.tag || null,
        sessionId: next.sessionId || job.input.sessionId || null,
        role: next.role || job.input.role || null,
      };
    }
    job.label = next.tag || next.sessionId || job.label;
  }

  function closePreparedSpawn(prepared, reason = 'agent-task-cancel') {
    if (!prepared?.session?.id) return;
    try { mgr.closeSession(prepared.session.id, reason); } catch {}
    try { clearBridgeStatuslineRoute(prepared.session.id); } catch {}
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

  function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const jobMeta = {
      ...(meta || {}),
      ...(clientHostPid ? { clientHostPid } : {}),
    };
    let task;
    task = startBackgroundTask({
      surface: 'agent',
      operation: type,
      label: jobMeta?.tag || jobMeta?.sessionId || type,
      input: { type, tag: jobMeta?.tag || null, sessionId: jobMeta?.sessionId || null, role: jobMeta?.role || null },
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
      const prepared = await prepareSpawn(args, callerCwd, context);
      mergeJobMeta(job, preparedSpawnMeta(prepared, extras));
      upsertWorkerSession(prepared.session, prepared.tag, {
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
      return await runSpawn(prepared, notifyContext);
    }, notifyContext);
  }

  function startProgressIdleWatchdog(sessionId, idleTimeoutMs, firstResponseTimeoutMs = DEFAULT_FIRST_RESPONSE_TIMEOUT_MS) {
    const staleMs = resolveWatchdogMs(idleTimeoutMs, DEFAULT_STALE_TIMEOUT_MS);
    const firstMs = resolveWatchdogMs(firstResponseTimeoutMs, DEFAULT_FIRST_RESPONSE_TIMEOUT_MS);
    if (!sessionId || (!staleMs && !firstMs)) return null;
    if (typeof mgr.getSessionProgressSnapshot !== 'function' && typeof mgr.getSessionLastProgressAt !== 'function') return null;
    if (typeof mgr.linkParentSignalToSession !== 'function') return null;
    const controller = new AbortController();
    try { mgr.linkParentSignalToSession(sessionId, controller.signal); } catch { return null; }
    const timer = setInterval(() => {
      const now = Date.now();
      const snapshot = typeof mgr.getSessionProgressSnapshot === 'function'
        ? mgr.getSessionProgressSnapshot(sessionId)
        : null;
      if (snapshot) {
        if (snapshot.waitingForFirstActivity) {
          const startedAt = snapshot.modelRequestStartedAt || snapshot.askStartedAt;
          if (firstMs && startedAt && now - startedAt > firstMs) {
            try { controller.abort(new Error(`agent first response stale (${firstMs}ms)`)); } catch {}
          }
          return;
        }
        const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
        if (staleMs && last && now - last > staleMs) {
          try { controller.abort(new Error(`agent task stale (${staleMs}ms without stream/tool progress)`)); } catch {}
        }
        return;
      }
      const last = mgr.getSessionLastProgressAt(sessionId);
      if (staleMs && last && now - last > staleMs) {
        try { controller.abort(new Error(`agent task stale (${staleMs}ms without progress)`)); } catch {}
      }
    }, 1000);
    timer.unref?.();
    return {
      stop: () => {
        try { clearInterval(timer); } catch {}
      },
    };
  }

  async function prepareSpawn(args, callerCwd = null, context = {}) {
    refreshTagsFromSessions({ context });
    const config = cfgMod.loadConfig();
    const role = normalizeAgentName(args.agent || args.role);
    if (!role) throw new Error('agent spawn: agent is required');
    const agentPermission = readAgentFrontmatterPermission(role, dataDir);
    const rolePermission = normalizeAgentPermission(agentPermission) || null;
    const { presetName, preset } = resolvePreset(config, args);
    await ensureProvider(config, preset.provider);

    const tag = clean(args.tag) || nextTag(role, context);
    if (resolveTag(tag, context, { scanSessions: wantsSessionScan(args) })) throw new Error(`agent spawn: tag "${tag}" already exists`);
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'bridge', agentId: tag });
    const maxLoopIterations = positiveInt(args.maxLoopIterations) || null;
    const idleTimeoutMs = resolveWatchdogMs(args.idleTimeoutMs, DEFAULT_STALE_TIMEOUT_MS);
    const firstResponseTimeoutMs = resolveWatchdogMs(args.firstResponseTimeoutMs, DEFAULT_FIRST_RESPONSE_TIMEOUT_MS);
    const { session, effectiveCwd } = prepareBridgeSession({
      role,
      presetName,
      preset,
      runtimeSpec,
      owner: AGENT_OWNER,
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: role,
      parentSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      ownerSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      clientHostPid: terminalPidForContext(context) || null,
      bridgeTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      maxLoopIterations: maxLoopIterations || undefined,
      permission: rolePermission || undefined,
      cacheKeyOverride: args.cacheKey || undefined,
    });
    // Lead sessions write a gateway-session route when created; agent sessions
    // are built through prepareBridgeSession(), so mirror that registration here
    // or the vendored L1/L2 statusline cannot resolve the agent route/model.
    writeBridgeStatuslineRoute(session.id, preset);
    bindTag(tag, session, {
      role,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'idle',
      stage: 'idle',
    });
    cancelReap(session.id);
    return { args, tag, session, role, preset, presetName, workerCwd: effectiveCwd || workerCwd, prompt, maxLoopIterations, idleTimeoutMs, firstResponseTimeoutMs };
  }

  async function runSpawn(prepared, notifyContext = null) {
    const { args, tag, session, role, preset, presetName, workerCwd, prompt, idleTimeoutMs, firstResponseTimeoutMs } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, idleTimeoutMs, firstResponseTimeoutMs);
    let finalStatus = 'idle';
    upsertWorkerSession(session, tag, {
      role,
      preset: presetKey(preset) || presetName,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort || null,
      fast: preset.fast === true,
      status: 'running',
      stage: 'running',
    });
    try {
      const result = await mgr.askSession(session.id, prompt, args.context || null, null, workerCwd, null, {
        notifyFn: workerNotifyFn(session.id, notifyContext || {}),
      });
      const content = result?.content || '';
      return {
        tag,
        sessionId: session.id,
        role,
        preset: presetKey(preset) || presetName,
        provider: preset.provider,
        model: preset.model,
        effort: preset.effort || null,
        fast: preset.fast === true,
        content,
      };
    } catch (error) {
      finalStatus = 'error';
      throw error;
    } finally {
      watchdog?.stop?.();
      upsertWorkerSession(session, tag, {
        role,
        preset: presetKey(preset) || presetName,
        provider: preset.provider,
        model: preset.model,
        effort: preset.effort || null,
        fast: preset.fast === true,
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
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

  async function runSend(prepared, notifyContext = null) {
    const { args, session, sessionId, prompt } = prepared;
    const watchdog = startProgressIdleWatchdog(
      sessionId,
      resolveWatchdogMs(args.idleTimeoutMs, DEFAULT_STALE_TIMEOUT_MS),
      resolveWatchdogMs(args.firstResponseTimeoutMs, DEFAULT_FIRST_RESPONSE_TIMEOUT_MS),
    );
    const tag = tagForSession(sessionId);
    let finalStatus = 'idle';
    upsertWorkerSession(session, tag, { status: 'running', stage: 'running' });
    try {
      const result = await mgr.askSession(sessionId, prompt, args.context || null, null, session.cwd || defaultCwd, null, {
        notifyFn: workerNotifyFn(sessionId, notifyContext || {}),
      });
      return {
        tag,
        sessionId,
        role: session.role || null,
        provider: session.provider,
        model: session.model,
        content: result?.content || '',
      };
    } catch (error) {
      finalStatus = 'error';
      throw error;
    } finally {
      watchdog?.stop?.();
      upsertWorkerSession(session, tag, {
        status: finalStatus,
        stage: finalStatus,
        finishedAt: new Date().toISOString(),
      });
      scheduleReap(sessionId);
    }
  }

  async function send(args) {
    return await runSend(await prepareSend(args));
  }

  function close(args, context = {}) {
    const scopedContext = bridgeScope(args, context);
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
      if (!target.startsWith('sess_') && tagRoles.has(target)) {
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
    clearBridgeStatuslineRoute(sessionId);
    const ok = mgr.closeSession(sessionId, 'cli-agent-close');
    if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by agent close');
    return { closed: ok, tag, sessionId, task_id: task?.taskId || null };
  }

  function cleanup(args = {}, context = {}) {
    const scopedContext = bridgeScope(args, context);
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
    for (const { tag, session } of bridgeSessionEntries({ scanSessions: false, context: {} })) {
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
    writeWorkerRows((byKey) => byKey.clear());
    return { closed, failed };
  }

  function coldRespawnArgs(args = {}, context = {}) {
    const target = clean(args.tag || args.sessionId);
    if (!target || target.startsWith('sess_') || resolveTag(target, context)) return null;
    const recoveredRole = clean(args.agent || args.role) || tagRoles.get(target);
    if (!recoveredRole) return null;
    return {
      ...args,
      type: 'spawn',
      tag: target,
      agent: recoveredRole,
      role: recoveredRole,
      prompt: args.prompt ?? args.message,
      cwd: args.cwd ?? tagCwds.get(target) ?? undefined,
      respawned: true,
    };
  }

  async function execute(args = {}, context = {}) {
    try {
      const type = clean(args.type) || 'spawn';
      const callerCwd = clean(context.cwd || context.callerCwd);
      const scopedContext = bridgeScope(args, context);
      const notifyContext = context;
      if (type === 'list') return renderResult({ bridgeMode: defaultMode, workers: list({ scanSessions: wantsSessionScan(args), context: scopedContext }), jobs: listJobs(scopedContext) });
      if (type === 'status') return renderResult(renderJob(getJob(args, scopedContext), false));
      if (type === 'read') return renderResult(renderJob(getJob(args, scopedContext), true));
      if (type === 'cleanup') return renderResult(cleanup(args, scopedContext));
      if (type === 'cancel') return renderResult(close(args, scopedContext));
      if (type === 'close') return renderResult(close(args, scopedContext));
      if (type === 'send') {
        const respawnArgs = coldRespawnArgs(args, scopedContext);
        if (respawnArgs) {
          if (modeFor(args, context) === 'async') {
            const job = startDeferredSpawnJob(respawnArgs, callerCwd, context, notifyContext, { respawned: true });
            return renderResult({ mode: 'async', respawned: true, ...renderJob(job, false) });
          }
          const prepared = await prepareSpawn(respawnArgs, callerCwd, context);
          return renderResult({ respawned: true, ...(await runSpawn(prepared, notifyContext)) });
        }
        const prepared = await prepareSend(args, scopedContext);
        if (isSessionBusy(prepared.sessionId) && typeof mgr.enqueuePendingMessage === 'function') {
          const queueDepth = mgr.enqueuePendingMessage(prepared.sessionId, prepared.prompt);
          return renderResult({
            queued: true,
            tag: tagForSession(prepared.sessionId),
            sessionId: prepared.sessionId,
            role: prepared.session.role || null,
            queueDepth,
          });
        }
        if (modeFor(args, context) === 'async') {
          const job = startJob('send', {
            tag: tagForSession(prepared.sessionId),
            sessionId: prepared.sessionId,
            role: prepared.session.role || null,
            provider: prepared.session.provider || null,
            model: prepared.session.model || null,
            preset: prepared.session.presetName || null,
            effort: prepared.session.effort || null,
            fast: prepared.session.fast === true,
          }, () => runSend(prepared, notifyContext), notifyContext);
          return renderResult({ mode: 'async', ...renderJob(job, false) });
        }
        return renderResult(await runSend(prepared, notifyContext));
      }
      if (type === 'spawn') {
        if (modeFor(args, context) === 'async') {
          const job = startDeferredSpawnJob(args, callerCwd, context, notifyContext);
          return renderResult({ mode: 'async', ...renderJob(job, false) });
        }
        const prepared = await prepareSpawn(args, callerCwd, context);
        return renderResult(await runSpawn(prepared, notifyContext));
      }
      throw new Error(`agent: unknown type "${type}"`);
    } catch (err) {
      return `Error: ${presentErrorText(err, { surface: 'agent' })}`;
    }
  }

  return {
    tools: [BRIDGE_TOOL],
    execute,
    getStatus: (context = {}) => {
      const scopedContext = bridgeScope({}, context);
      const pid = terminalPidForContext(scopedContext);
      return {
        bridgeMode: defaultMode,
        workers: list({ scanSessions: false, context: scopedContext }),
        jobs: listJobs(scopedContext),
        scope: pid ? { clientHostPid: pid } : { allTerminals: true },
      };
    },
    recoverWorkers: (context = {}) => {
      const scopedContext = bridgeScope({ recover: true }, context);
      refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
      return list({ scanSessions: false, context: scopedContext });
    },
    getDefaultMode: () => defaultMode,
    setDefaultMode: (mode) => {
      defaultMode = normalizeMode(mode);
      return defaultMode;
    },
    toggleDefaultMode: () => {
      defaultMode = defaultMode === 'sync' ? 'async' : 'sync';
      return defaultMode;
    },
    closeAll,
  };
}
