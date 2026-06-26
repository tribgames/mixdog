import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  executionModeSchemaDescription,
  getBackgroundTask,
  listBackgroundTasks,
  resolveExecutionMode,
  startBackgroundTask,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { prepareBridgeSession } from '../runtime/agent/orchestrator/smart-bridge/session-builder.mjs';
import { clearGatewaySessionRoute, writeGatewaySessionRoute } from '../vendor/statusline/src/gateway/session-routes.mjs';

const ROLE_PERMISSION_ALIASES = new Map([
  ['readonly', 'read'],
  ['read-only', 'read'],
  ['read', 'read'],
  ['full', 'full'],
]);

const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

const DEFAULT_AGENT_PRESETS = Object.freeze({
  explore: 'sonnet-high',
  'web-researcher': 'sonnet-high',
  maintainer: 'haiku',
  worker: 'sonnet-high',
  'heavy-worker': 'opus-high',
  reviewer: 'opus-xhigh',
  debugger: 'opus-xhigh',
});

export const BRIDGE_TOOL = {
  name: 'bridge',
  title: 'Bridge Agent',
  annotations: {
    title: 'Bridge Agent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    bridgeHidden: true,
  },
  description: 'Delegate scoped work to workflow agents. Prefer async by default: spawn independent agents in parallel with distinct tags, then wait for their completion notification; do not interfere or poll while delegated work is running. Use sync only when the next step must block on the result.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Action. Default spawn; use send only for a follow-up to an existing tag/session.' },
      mode: { type: 'string', enum: ['async', 'sync'], description: `${executionModeSchemaDescription('async')} Prefer async for model handoffs; use sync only for an explicit blocking handoff.` },
      task_id: { type: 'string', description: 'Shared background task id for manual status/read/cancel recovery.' },
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

const FINISHED_JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 200;
const TERMINAL_REAP_MS = 60 * 60_000;
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

function normalizePermission(value) {
  const key = clean(value).toLowerCase();
  return ROLE_PERMISSION_ALIASES.get(key) || (key ? key : undefined);
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

function readRoles(dataDir) {
  const file = resolve(dataDir, 'user-workflow.json');
  if (!existsSync(file)) return new Map();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const roles = new Map();
  for (const role of raw?.roles || []) {
    if (!role?.name || !role?.preset) continue;
    roles.set(String(role.name), {
      name: String(role.name),
      preset: String(role.preset),
      permission: normalizePermission(role.permission) || 'full',
      desc_path: typeof role.desc_path === 'string' ? role.desc_path : null,
      maxLoopIterations: positiveInt(role.maxLoopIterations),
      idleTimeoutMs: nonNegativeInt(role.idleTimeoutMs),
      firstResponseTimeoutMs: nonNegativeInt(role.firstResponseTimeoutMs),
    });
  }
  return roles;
}

async function resolvePrompt(args, cwd) {
  const prompt = clean(args.prompt || args.message);
  const file = clean(args.file);
  if (prompt && file) throw new Error('bridge: provide only one of prompt/message or file');
  if (prompt) return prompt;
  if (file) {
    const target = isAbsolute(file) ? file : resolve(cwd || process.cwd(), file);
    return readFileSync(target, 'utf8');
  }
  throw new Error('bridge: prompt/message/file is required');
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
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const lines = [];

    if (Array.isArray(value.workers) || Array.isArray(value.jobs)) {
      lines.push(`bridge mode: ${value.bridgeMode || 'async'}`);
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
        lines.push(`- ${job.task_id} ${job.type} ${job.status} target=${target}${terminal}${job.error ? ` error=${presentErrorText(job.error, { surface: 'bridge' })}` : ''}`);
      }
      if (workers.length === 0 && jobs.length === 0) lines.push('(no bridge agents or tasks)');
      return lines.join('\n');
    }

    if (value.task_id) {
      lines.push(`bridge task: ${value.task_id}`);
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
      if (value.error) lines.push(`error: ${presentErrorText(value.error, { surface: 'bridge' })}`);
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
        'bridge message queued',
        `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
        value.role ? `agent: ${value.role}` : null,
        `queueDepth: ${value.queueDepth ?? 1}`,
      ].filter(Boolean).join('\n');
    }

    if (value.closed !== undefined) {
      return [
        `bridge close: ${value.closed ? 'ok' : 'not closed'}`,
        value.tag ? `tag: ${value.tag}` : null,
        value.sessionId ? `sessionId: ${value.sessionId}` : null,
        value.task_id ? `task_id: ${value.task_id}` : null,
        value.forgotten ? 'forgotten: true' : null,
      ].filter(Boolean).join('\n');
    }

    if (value.content !== undefined) {
      const header = [
        value.respawned ? 'bridge respawned' : 'bridge result',
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
  const jobs = new Map();
  const reapTimers = new Map();
  let tagSeq = 0;
  let jobSeq = 0;
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

  function nextJobId(type) {
    jobSeq += 1;
    return `job_${Date.now()}_${jobSeq}_${clean(type) || 'bridge'}`;
  }

  function resolveTag(target, context = {}) {
    refreshTagsFromSessions({ context });
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) {
      const session = getLiveSession(value);
      return session && sessionMatchesContext(session, context) ? value : null;
    }
    const matches = bridgeSessionEntries({ scanSessions: true, context })
      .filter((entry) => entry.tag === value);
    if (matches.length === 1) return matches[0].session.id;
    if (matches.length > 1) {
      throw new Error(`bridge: tag "${value}" is ambiguous across terminals; use sessionId`);
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

  function bridgeSessionEntries({ scanSessions = true, context = {} } = {}) {
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
    if (scanSessions) {
      for (const session of mgr.listSessions({ includeClosed: false }) || []) {
        add(session, session?.bridgeTag);
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

  function refreshTagsFromSessions({ scanSessions = true, context = {} } = {}) {
    for (const [tag, sessionId] of [...tags.entries()]) {
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
    }
  }

  function bindTag(tag, session) {
    if (!tag || !session?.id) return;
    tags.set(tag, session.id);
    if (session.role) tagRoles.set(tag, session.role);
    if (session.cwd) tagCwds.set(tag, session.cwd);
  }

  function forgetTag(tag) {
    if (!tag) return;
    tags.delete(tag);
    tagRoles.delete(tag);
    tagCwds.delete(tag);
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

  function pruneJobs({ force = false } = {}) {
    const now = Date.now();
    for (const [jobId, job] of [...jobs.entries()]) {
      if (job.status === 'running' && !force) continue;
      const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : 0;
      if (force || (finishedAt > 0 && now - finishedAt > FINISHED_JOB_TTL_MS)) {
        jobs.delete(jobId);
      }
    }
    if (jobs.size <= MAX_JOBS) return;
    const removable = [...jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => Date.parse(a.finishedAt || a.startedAt || 0) - Date.parse(b.finishedAt || b.startedAt || 0));
    while (jobs.size > MAX_JOBS && removable.length > 0) {
      const job = removable.shift();
      jobs.delete(job.jobId);
    }
  }

  async function ensureProvider(config, provider) {
    const providers = { ...(config.providers || {}) };
    providers[provider] = { ...(providers[provider] || {}), enabled: true };
    await reg.initProviders(providers);
  }

  function resolvePreset(config, args, roleCfg) {
    if (args.provider && args.model) {
      return {
        presetName: args.preset || '__direct__',
        preset: {
          id: '__direct__',
          name: '__DIRECT__',
          type: 'bridge',
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
          type: 'bridge',
          provider: agentRoute.provider,
          model: agentRoute.model,
          effort: agentRoute.effort,
          fast: agentRoute.fast === true,
          tools: 'full',
        },
      };
    }

    const presetName = clean(args.preset) || roleCfg?.preset || DEFAULT_AGENT_PRESETS[agentName];
    if (!presetName) throw new Error(`bridge: agent "${agentName}" has no model assignment`);
    const preset = findPreset(config, presetName) || synthesizePreset(config, presetName);
    if (!preset) throw new Error(`bridge: preset "${presetName}" not found`);
    return { presetName, preset };
  }

  function list({ scanSessions = true, context = {} } = {}) {
    refreshTagsFromSessions({ scanSessions, context });
    const now = Date.now();
    const rows = [];
    for (const { tag, session } of bridgeSessionEntries({ scanSessions, context })) {
      const sessionId = session.id;
      const runtime = mgr.getSessionRuntime?.(sessionId);
      const status = session.closed === true ? 'closed' : (session.status || 'idle');
      const stage = status === 'idle' || status === 'error' || status === 'closed'
        ? status
        : (runtime?.stage || status);
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
        messages: Array.isArray(session.messages) ? session.messages.length : 0,
        tools: Array.isArray(session.tools) ? session.tools.length : 0,
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
    const rows = listBackgroundTasks({ surface: 'bridge', context }).map((task) => ({
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
    if (!taskId) throw new Error('bridge read/status: task_id is required');
    const task = getBackgroundTask(taskId, { surface: 'bridge', context });
    if (!task) throw new Error(`bridge read/status: task "${taskId}" not found`);
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

  function closePreparedSpawn(prepared, reason = 'bridge-task-cancel') {
    if (!prepared?.session?.id) return;
    try { mgr.closeSession(prepared.session.id, reason); } catch {}
    try { clearBridgeStatuslineRoute(prepared.session.id); } catch {}
    if (prepared.tag) forgetTag(prepared.tag);
  }

  function startJob(type, meta, run, notifyContext = null) {
    const clientHostPid = terminalPidForContext(notifyContext);
    const jobMeta = {
      ...(meta || {}),
      ...(clientHostPid ? { clientHostPid } : {}),
    };
    let task;
    task = startBackgroundTask({
      surface: 'bridge',
      operation: type,
      label: jobMeta?.tag || jobMeta?.sessionId || type,
      input: { type, tag: jobMeta?.tag || null, sessionId: jobMeta?.sessionId || null, role: jobMeta?.role || null },
      context: notifyContext,
      meta: jobMeta,
      resultType: 'bridge_task_result',
      renderResult: (result) => renderResult(result),
      cancel: () => {
        const currentMeta = task?.meta || jobMeta;
        if (currentMeta?.sessionId) {
          try { mgr.closeSession(currentMeta.sessionId, 'bridge-task-cancel'); } catch {}
        }
      },
      run: async () => {
        // Yield one macrotask before doing bridge work. startBackgroundTask uses
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
      if (job?.status === 'cancelled') {
        closePreparedSpawn(prepared);
        return null;
      }
      return await runSpawn(prepared);
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
            try { controller.abort(new Error(`bridge first response stale (${firstMs}ms)`)); } catch {}
          }
          return;
        }
        const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
        if (staleMs && last && now - last > staleMs) {
          try { controller.abort(new Error(`bridge task stale (${staleMs}ms without stream/tool progress)`)); } catch {}
        }
        return;
      }
      const last = mgr.getSessionLastProgressAt(sessionId);
      if (staleMs && last && now - last > staleMs) {
        try { controller.abort(new Error(`bridge task stale (${staleMs}ms without progress)`)); } catch {}
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
    const roles = readRoles(dataDir);
    const role = normalizeAgentName(args.agent || args.role);
    if (!role) throw new Error('bridge spawn: agent is required');
    const roleCfg = roles.get(role);
    const { presetName, preset } = resolvePreset(config, args, roleCfg);
    await ensureProvider(config, preset.provider);

    const tag = clean(args.tag) || nextTag(role, context);
    if (resolveTag(tag, context)) throw new Error(`bridge spawn: tag "${tag}" already exists`);
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'bridge', agentId: tag });
    const maxLoopIterations = positiveInt(args.maxLoopIterations) || roleCfg?.maxLoopIterations || null;
    const idleTimeoutMs = resolveWatchdogMs(args.idleTimeoutMs, roleCfg?.idleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS);
    const firstResponseTimeoutMs = resolveWatchdogMs(args.firstResponseTimeoutMs, roleCfg?.firstResponseTimeoutMs ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MS);
    const { session, effectiveCwd } = prepareBridgeSession({
      role,
      presetName,
      preset,
      runtimeSpec,
      owner: 'bridge',
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: role,
      clientHostPid: terminalPidForContext(context) || null,
      bridgeTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      maxLoopIterations: maxLoopIterations || undefined,
      permission: normalizePermission(roleCfg?.permission) || 'full',
      cacheKeyOverride: args.cacheKey || undefined,
    });
    // Lead sessions write a gateway-session route when created; bridge agents
    // are built through prepareBridgeSession(), so mirror that registration here
    // or the vendored L1/L2 statusline cannot resolve the agent route/model.
    writeBridgeStatuslineRoute(session.id, preset);
    bindTag(tag, session);
    cancelReap(session.id);
    return { args, tag, session, role, preset, presetName, workerCwd: effectiveCwd || workerCwd, prompt, maxLoopIterations, idleTimeoutMs, firstResponseTimeoutMs };
  }

  async function runSpawn(prepared) {
    const { args, tag, session, role, preset, presetName, workerCwd, prompt, idleTimeoutMs, firstResponseTimeoutMs } = prepared;
    const watchdog = startProgressIdleWatchdog(session.id, idleTimeoutMs, firstResponseTimeoutMs);
    try {
      const result = await mgr.askSession(session.id, prompt, args.context || null, null, workerCwd);
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
    } finally {
      watchdog?.stop?.();
      scheduleReap(session.id);
    }
  }

  async function spawn(args) {
    return await runSpawn(await prepareSpawn(args));
  }

  async function prepareSend(args, context = {}) {
    refreshTagsFromSessions({ context });
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('bridge send: tag or sessionId is required');
    const sessionId = resolveTag(target, context);
    if (!sessionId) throw new Error(`bridge send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`bridge send: session "${sessionId}" is closed`);
    cancelReap(sessionId);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    return { args, session, sessionId, prompt };
  }

  async function runSend(prepared) {
    const { args, session, sessionId, prompt } = prepared;
    const watchdog = startProgressIdleWatchdog(
      sessionId,
      resolveWatchdogMs(args.idleTimeoutMs, DEFAULT_STALE_TIMEOUT_MS),
      resolveWatchdogMs(args.firstResponseTimeoutMs, DEFAULT_FIRST_RESPONSE_TIMEOUT_MS),
    );
    try {
      const result = await mgr.askSession(sessionId, prompt, args.context || null, null, session.cwd || defaultCwd);
      return {
        tag: tagForSession(sessionId),
        sessionId,
        role: session.role || null,
        provider: session.provider,
        model: session.model,
        content: result?.content || '',
      };
    } finally {
      watchdog?.stop?.();
      scheduleReap(sessionId);
    }
  }

  async function send(args) {
    return await runSend(await prepareSend(args));
  }

  function close(args, context = {}) {
    const scopedContext = bridgeScope(args, context);
    refreshTagsFromSessions({ context: scopedContext });
    const taskId = taskIdFromArgs(args);
    const task = taskId ? getBackgroundTask(taskId, { surface: 'bridge', context }) : null;
    const taskMeta = task?.meta || {};
    const target = clean(args.tag || args.sessionId || taskMeta.sessionId);
    if (!target) {
      if (task?.taskId) {
        cancelBackgroundTask(task.taskId, 'cancelled by bridge close');
        return { closed: true, tag: taskMeta.tag || null, sessionId: null, task_id: task.taskId };
      }
      throw new Error('bridge close: tag or sessionId is required');
    }
    const sessionId = resolveTag(target, scopedContext);
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagRoles.has(target)) {
        forgetTag(target);
        if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by bridge close');
        return { closed: true, forgotten: true, tag: target, sessionId: null, task_id: task?.taskId || null };
      }
      throw new Error(`bridge close: target "${target}" not found`);
    }
    cancelReap(sessionId);
    const tag = tagForSession(sessionId);
    if (tag) forgetTag(tag);
    clearBridgeStatuslineRoute(sessionId);
    const ok = mgr.closeSession(sessionId, 'cli-bridge-close');
    if (task?.taskId) cancelBackgroundTask(task.taskId, 'cancelled by bridge close');
    return { closed: ok, tag, sessionId, task_id: task?.taskId || null };
  }

  function cleanup(args = {}, context = {}) {
    const scopedContext = bridgeScope(args, context);
    const beforeTags = tags.size;
    refreshTagsFromSessions({ context: scopedContext });
    const cleaned = cleanupBackgroundTasks({ surface: 'bridge', context: scopedContext, force: args.force === true });
    return {
      jobsRemoved: cleaned.removed,
      tagsRemoved: beforeTags - tags.size,
      jobs: listJobs(scopedContext).length,
      workers: list({ context: scopedContext }).length,
    };
  }

  function closeAll(reason = 'cli-bridge-close-all') {
    refreshTagsFromSessions();
    const closed = [];
    const failed = [];
    for (const { tag, session } of bridgeSessionEntries({ scanSessions: true, context: {} })) {
      try {
        closed.push(close({ sessionId: session.id }));
      } catch (err) {
        failed.push({ tag, error: presentErrorText(err, { surface: 'bridge' }) });
      }
    }
    for (const task of listBackgroundTasks({ surface: 'bridge' })) {
      if (task?.status !== 'running') continue;
      cancelBackgroundTask(task.task_id, reason);
      closed.push({ closed: true, tag: task.tag || null, sessionId: task.sessionId || null, task_id: task.task_id });
    }
    for (const timer of reapTimers.values()) clearTimeout(timer);
    reapTimers.clear();
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
      if (type === 'list') return renderResult({ bridgeMode: defaultMode, workers: list({ context: scopedContext }), jobs: listJobs(scopedContext) });
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
          return renderResult({ respawned: true, ...(await runSpawn(prepared)) });
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
          }, () => runSend(prepared), notifyContext);
          return renderResult({ mode: 'async', ...renderJob(job, false) });
        }
        return renderResult(await runSend(prepared));
      }
      if (type === 'spawn') {
        if (modeFor(args, context) === 'async') {
          const job = startDeferredSpawnJob(args, callerCwd, context, notifyContext);
          return renderResult({ mode: 'async', ...renderJob(job, false) });
        }
        const prepared = await prepareSpawn(args, callerCwd, context);
        return renderResult(await runSpawn(prepared));
      }
      throw new Error(`bridge: unknown type "${type}"`);
    } catch (err) {
      return `Error: ${presentErrorText(err, { surface: 'bridge' })}`;
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
        workers: list({ scanSessions: true, context: scopedContext }),
        jobs: listJobs(scopedContext),
        scope: pid ? { clientHostPid: pid } : { allTerminals: true },
      };
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
