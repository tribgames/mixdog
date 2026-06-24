import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { prepareBridgeSession } from '../runtime/agent/orchestrator/smart-bridge/session-builder.mjs';

const ROLE_PERMISSION_ALIASES = new Map([
  ['readonly', 'read'],
  ['read-only', 'read'],
  ['read', 'read'],
  ['full', 'full'],
]);

const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

export const BRIDGE_TOOL = {
  name: 'bridge',
  title: 'Bridge Worker',
  annotations: {
    title: 'Bridge Worker',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    bridgeHidden: true,
  },
  description: 'Spawn, send to, list, close, cancel, or read standalone mixdog-cli worker agents. type=spawn|send|list|close|cancel|status|read|cleanup. spawn/send can run sync or async.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Action. Default: spawn.' },
      mode: { type: 'string', enum: ['sync', 'async'], description: 'Execution mode for spawn/send. Overrides the CLI default bridge mode.' },
      wait: { type: 'boolean', description: 'For spawn/send: true waits for completion, false returns a job handle immediately.' },
      jobId: { type: 'string', description: 'Async job id for status/read.' },
      role: { type: 'string', description: 'Worker role from user-workflow.json, e.g. worker/reviewer/debugger.' },
      tag: { type: 'string', description: 'Stable worker handle. Optional for spawn, required for send/close unless sessionId is used.' },
      sessionId: { type: 'string', description: 'Raw sess_ id for send/close.' },
      prompt: { type: 'string', description: 'Worker task brief for spawn.' },
      message: { type: 'string', description: 'Follow-up message for send, or task brief for spawn.' },
      file: { type: 'string', description: 'Read the worker prompt from a file.' },
      provider: { type: 'string', description: 'Override provider.' },
      model: { type: 'string', description: 'Override model.' },
      preset: { type: 'string', description: 'Override preset id/name.' },
      effort: { type: 'string', description: 'Override reasoning effort.' },
      fast: { type: 'boolean', description: 'Enable provider fast mode when supported.' },
      cwd: { type: 'string', description: 'Worker working directory.' },
      context: { type: 'string', description: 'Extra context passed to the worker turn.' },
    },
    additionalProperties: true,
  },
};

const FINISHED_JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 200;
const TERMINAL_REAP_MS = 60 * 60_000;
const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);

function clean(value) {
  return String(value ?? '').trim();
}

function normalizePermission(value) {
  const key = clean(value).toLowerCase();
  return ROLE_PERMISSION_ALIASES.get(key) || (key ? key : undefined);
}

function presetKey(preset) {
  return clean(preset?.id || preset?.name);
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

function renderResult(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const lines = [];

    if (Array.isArray(value.workers) || Array.isArray(value.jobs)) {
      lines.push(`bridge mode: ${value.bridgeMode || 'sync'}`);
      const workers = Array.isArray(value.workers) ? value.workers : [];
      lines.push(`workers: ${workers.length}`);
      for (const worker of workers) {
        const stale = Number.isFinite(worker.staleSeconds) ? ` stale=${worker.staleSeconds}s` : '';
        const tokens = worker.windowTokens ? ` ctx=${worker.windowTokens}${worker.windowCap ? `/${worker.windowCap}` : ''}` : '';
        lines.push(`- ${worker.tag} ${worker.role || 'worker'} ${worker.status || 'idle'}/${worker.stage || 'idle'} ${worker.provider}/${worker.model}${stale}${tokens}`);
      }
      const jobs = Array.isArray(value.jobs) ? value.jobs : [];
      lines.push(`jobs: ${jobs.length}`);
      for (const job of jobs) {
        const target = job.tag || job.sessionId || '-';
        lines.push(`- ${job.jobId} ${job.type} ${job.status} target=${target}${job.error ? ` error=${job.error}` : ''}`);
      }
      if (workers.length === 0 && jobs.length === 0) lines.push('(no bridge workers or jobs)');
      return lines.join('\n');
    }

    if (value.jobId) {
      lines.push(`bridge job: ${value.jobId}`);
      lines.push(`status: ${value.status}${value.mode ? ` (${value.mode})` : ''}`);
      if (value.type) lines.push(`type: ${value.type}`);
      if (value.tag || value.sessionId) lines.push(`target: ${value.tag || '-'} ${value.sessionId || ''}`.trim());
      if (value.role) lines.push(`role: ${value.role}`);
      if (value.stage || value.workerStatus) lines.push(`worker: ${value.workerStatus || 'unknown'}/${value.stage || 'unknown'}`);
      if (value.startedAt) lines.push(`started: ${compactIso(value.startedAt)}`);
      if (value.finishedAt) lines.push(`finished: ${compactIso(value.finishedAt)}`);
      if (value.error) lines.push(`error: ${value.error}`);
      if (value.status === 'running') lines.push(`read: bridge type=read jobId=${value.jobId}`);
      if (value.result !== undefined) {
        const result = value.result;
        const content = typeof result === 'string' ? result : result?.content;
        if (content) lines.push('', String(content).trim());
        else lines.push('', JSON.stringify(result, null, 2));
      }
      return lines.join('\n');
    }

    if (value.queued) {
      return [
        'bridge message queued',
        `target: ${value.tag || '-'} ${value.sessionId || ''}`.trim(),
        value.role ? `role: ${value.role}` : null,
        `queueDepth: ${value.queueDepth ?? 1}`,
      ].filter(Boolean).join('\n');
    }

    if (value.closed !== undefined) {
      return [
        `bridge close: ${value.closed ? 'ok' : 'not closed'}`,
        value.tag ? `tag: ${value.tag}` : null,
        value.sessionId ? `sessionId: ${value.sessionId}` : null,
        value.jobId ? `jobId: ${value.jobId}` : null,
        value.forgotten ? 'forgotten: true' : null,
      ].filter(Boolean).join('\n');
    }

    if (value.content !== undefined) {
      const header = [
        value.respawned ? 'bridge respawned' : 'bridge result',
        value.tag ? `tag=${value.tag}` : null,
        value.role ? `role=${value.role}` : null,
        value.provider && value.model ? `${value.provider}/${value.model}` : null,
      ].filter(Boolean).join(' ');
      return `${header}\n${String(value.content || '').trim()}`;
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

  function modeFor(args = {}) {
    if (args.wait === true) return 'sync';
    if (args.wait === false) return 'async';
    if (args.async === true) return 'async';
    if (args.async === false) return 'sync';
    return normalizeMode(args.mode || defaultMode);
  }

  function nextJobId(type) {
    jobSeq += 1;
    return `job_${Date.now()}_${jobSeq}_${clean(type) || 'bridge'}`;
  }

  function resolveTag(target) {
    refreshTagsFromSessions();
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) return getLiveSession(value) ? value : null;
    return tags.get(value) || null;
  }

  function getLiveSession(sessionId) {
    if (!sessionId) return null;
    const session = mgr.getSession(sessionId);
    return session && session.closed !== true ? session : null;
  }

  function tagForSession(sessionId) {
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  function nextTag(role) {
    refreshTagsFromSessions();
    let tag;
    do {
      tag = `${clean(role) || 'worker'}${++tagSeq}`;
    } while (tags.has(tag));
    return tag;
  }

  function refreshTagsFromSessions() {
    for (const [tag, sessionId] of [...tags.entries()]) {
      const session = getLiveSession(sessionId);
      if (!session || session.closed) tags.delete(tag);
    }
    for (const session of mgr.listSessions({ includeClosed: false }) || []) {
      const tag = clean(session?.bridgeTag);
      if (!tag || tags.has(tag)) continue;
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

    const presetName = clean(args.preset) || roleCfg?.preset;
    if (!presetName) throw new Error(`bridge: role "${args.role}" not found in user-workflow.json and no preset override was provided`);
    const preset = findPreset(config, presetName) || synthesizePreset(config, presetName);
    if (!preset) throw new Error(`bridge: preset "${presetName}" not found`);
    return { presetName, preset };
  }

  function list() {
    refreshTagsFromSessions();
    const now = Date.now();
    const rows = [];
    for (const [tag, sessionId] of tags.entries()) {
      const session = mgr.getSession(sessionId);
      if (!session || session.closed) continue;
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
        status,
        stage,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        lastUsedAt: session.lastUsedAt || null,
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
      lastStreamDeltaAt: runtime?.lastStreamDeltaAt ? new Date(runtime.lastStreamDeltaAt).toISOString() : null,
    };
  }

  function listJobs() {
    pruneJobs();
    return [...jobs.values()].map((job) => ({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      tag: job.tag || null,
      sessionId: job.sessionId || null,
      role: job.role || null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      ...jobWorkerSnapshot(job.sessionId),
    }));
  }

  function getJob(args) {
    pruneJobs();
    const jobId = clean(args.jobId || args.id);
    if (!jobId) throw new Error('bridge read/status: jobId is required');
    const job = jobs.get(jobId);
    if (!job) throw new Error(`bridge read/status: job "${jobId}" not found`);
    return job;
  }

  function renderJob(job, includeResult = false) {
    return {
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      tag: job.tag || null,
      sessionId: job.sessionId || null,
      role: job.role || null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      ...jobWorkerSnapshot(job.sessionId),
      ...(includeResult && job.result !== undefined ? { result: job.result } : {}),
    };
  }

  function startJob(type, meta, run) {
    pruneJobs();
    const job = {
      jobId: nextJobId(type),
      type,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: undefined,
      error: null,
      ...meta,
    };
    jobs.set(job.jobId, job);
    job.promise = Promise.resolve()
      .then(run)
      .then((result) => {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        job.result = result;
        return result;
      })
      .catch((error) => {
        if (job.status === 'cancelled') return null;
        job.status = 'error';
        job.finishedAt = new Date().toISOString();
        job.error = error?.message || String(error);
        return null;
      });
    return job;
  }

  async function prepareSpawn(args, callerCwd = null) {
    refreshTagsFromSessions();
    const config = cfgMod.loadConfig();
    const roles = readRoles(dataDir);
    const role = clean(args.role);
    if (!role) throw new Error('bridge spawn: role is required');
    const roleCfg = roles.get(role);
    const { presetName, preset } = resolvePreset(config, args, roleCfg);
    await ensureProvider(config, preset.provider);

    const tag = clean(args.tag) || nextTag(role);
    if (resolveTag(tag)) throw new Error(`bridge spawn: tag "${tag}" already exists`);
    const workerCwd = clean(args.cwd) ? resolve(args.cwd) : resolve(callerCwd || defaultCwd);
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'bridge', agentId: tag });
    const { session, effectiveCwd } = prepareBridgeSession({
      role,
      presetName,
      preset,
      runtimeSpec,
      owner: 'bridge',
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: role,
      bridgeTag: tag,
      permission: normalizePermission(roleCfg?.permission) || 'full',
      cacheKeyOverride: args.cacheKey || undefined,
    });
    bindTag(tag, session);
    cancelReap(session.id);
    return { args, tag, session, role, preset, presetName, workerCwd: effectiveCwd || workerCwd, prompt };
  }

  async function runSpawn(prepared) {
    const { args, tag, session, role, preset, presetName, workerCwd, prompt } = prepared;
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
        content,
      };
    } finally {
      scheduleReap(session.id);
    }
  }

  async function spawn(args) {
    return await runSpawn(await prepareSpawn(args));
  }

  async function prepareSend(args) {
    refreshTagsFromSessions();
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('bridge send: tag or sessionId is required');
    const sessionId = resolveTag(target);
    if (!sessionId) throw new Error(`bridge send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`bridge send: session "${sessionId}" is closed`);
    cancelReap(sessionId);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    return { args, session, sessionId, prompt };
  }

  async function runSend(prepared) {
    const { args, session, sessionId, prompt } = prepared;
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
      scheduleReap(sessionId);
    }
  }

  async function send(args) {
    return await runSend(await prepareSend(args));
  }

  function close(args) {
    refreshTagsFromSessions();
    const jobId = clean(args.jobId);
    const job = jobId ? jobs.get(jobId) : null;
    const target = clean(args.tag || args.sessionId || job?.sessionId);
    if (!target) throw new Error('bridge close: tag or sessionId is required');
    const sessionId = resolveTag(target);
    if (!sessionId) {
      if (!target.startsWith('sess_') && tagRoles.has(target)) {
        forgetTag(target);
        return { closed: true, forgotten: true, tag: target, sessionId: null, jobId: job?.jobId || null };
      }
      throw new Error(`bridge close: target "${target}" not found`);
    }
    cancelReap(sessionId);
    const tag = tagForSession(sessionId);
    if (tag) forgetTag(tag);
    const ok = mgr.closeSession(sessionId, 'cli-bridge-close');
    if (job && job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.error = 'cancelled by bridge close';
    }
    return { closed: ok, tag, sessionId, jobId: job?.jobId || null };
  }

  function cleanup(args = {}) {
    const beforeJobs = jobs.size;
    const beforeTags = tags.size;
    refreshTagsFromSessions();
    pruneJobs({ force: args.force === true });
    return {
      jobsRemoved: beforeJobs - jobs.size,
      tagsRemoved: beforeTags - tags.size,
      jobs: jobs.size,
      workers: list().length,
    };
  }

  function closeAll(reason = 'cli-bridge-close-all') {
    refreshTagsFromSessions();
    const closed = [];
    const failed = [];
    for (const tag of [...tags.keys()]) {
      try {
        closed.push(close({ tag }));
      } catch (err) {
        failed.push({ tag, error: err?.message || String(err) });
      }
    }
    for (const [jobId, job] of jobs.entries()) {
      if (job?.status !== 'running') continue;
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.error = reason;
      closed.push({ closed: true, tag: job.tag || null, sessionId: job.sessionId || null, jobId });
    }
    for (const timer of reapTimers.values()) clearTimeout(timer);
    reapTimers.clear();
    return { closed, failed };
  }

  function coldRespawnArgs(args = {}) {
    const target = clean(args.tag || args.sessionId);
    if (!target || target.startsWith('sess_') || resolveTag(target)) return null;
    const recoveredRole = clean(args.role) || tagRoles.get(target);
    if (!recoveredRole) return null;
    return {
      ...args,
      type: 'spawn',
      tag: target,
      role: recoveredRole,
      prompt: args.prompt ?? args.message,
      cwd: args.cwd ?? tagCwds.get(target) ?? undefined,
      respawned: true,
    };
  }

  async function execute(args = {}, context = {}) {
    const type = clean(args.type) || 'spawn';
    const callerCwd = clean(context.cwd || context.callerCwd);
    refreshTagsFromSessions();
    if (type === 'list') return renderResult({ bridgeMode: defaultMode, workers: list(), jobs: listJobs() });
    if (type === 'status') return renderResult(renderJob(getJob(args), false));
    if (type === 'read') return renderResult(renderJob(getJob(args), true));
    if (type === 'cleanup') return renderResult(cleanup(args));
    if (type === 'cancel') return renderResult(close(args));
    if (type === 'close') return renderResult(close(args));
    if (type === 'send') {
      const respawnArgs = coldRespawnArgs(args);
      if (respawnArgs) {
        const prepared = await prepareSpawn(respawnArgs, callerCwd);
        if (modeFor(args) === 'async') {
          const job = startJob('spawn', {
            tag: prepared.tag,
            sessionId: prepared.session.id,
            role: prepared.role,
            respawned: true,
          }, () => runSpawn(prepared));
          return renderResult({ mode: 'async', respawned: true, ...renderJob(job, false) });
        }
        return renderResult({ respawned: true, ...(await runSpawn(prepared)) });
      }
      const prepared = await prepareSend(args);
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
      if (modeFor(args) === 'async') {
        const job = startJob('send', {
          tag: tagForSession(prepared.sessionId),
          sessionId: prepared.sessionId,
          role: prepared.session.role || null,
        }, () => runSend(prepared));
        return renderResult({ mode: 'async', ...renderJob(job, false) });
      }
      return renderResult(await runSend(prepared));
    }
    if (type === 'spawn') {
      const prepared = await prepareSpawn(args, callerCwd);
      if (modeFor(args) === 'async') {
        const job = startJob('spawn', {
          tag: prepared.tag,
          sessionId: prepared.session.id,
          role: prepared.role,
        }, () => runSpawn(prepared));
        return renderResult({ mode: 'async', ...renderJob(job, false) });
      }
      return renderResult(await runSpawn(prepared));
    }
    throw new Error(`bridge: unknown type "${type}"`);
  }

  return {
    tools: [BRIDGE_TOOL],
    execute,
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
