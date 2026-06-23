import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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
  description: 'Spawn, resume, list, or close standalone mixdog-cli worker agents. type=spawn|send|list|close. spawn requires role and prompt/message.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close'], description: 'Action. Default: spawn.' },
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

function renderResult(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function createStandaloneBridge({ cfgMod, reg, mgr, dataDir, cwd: defaultCwd }) {
  const tags = new Map();
  let tagSeq = 0;

  function resolveTag(target) {
    const value = clean(target);
    if (!value) return null;
    if (value.startsWith('sess_')) return value;
    return tags.get(value) || null;
  }

  function tagForSession(sessionId) {
    for (const [tag, sid] of tags.entries()) {
      if (sid === sessionId) return tag;
    }
    return null;
  }

  function nextTag(role) {
    let tag;
    do {
      tag = `${clean(role) || 'worker'}${++tagSeq}`;
    } while (tags.has(tag));
    return tag;
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
    const rows = [];
    for (const [tag, sessionId] of tags.entries()) {
      const session = mgr.getSession(sessionId);
      if (!session || session.closed) continue;
      rows.push({
        tag,
        sessionId,
        role: session.role || null,
        provider: session.provider,
        model: session.model,
        status: session.status || 'active',
        messages: Array.isArray(session.messages) ? session.messages.length : 0,
      });
    }
    return rows;
  }

  async function spawn(args) {
    const config = cfgMod.loadConfig();
    const roles = readRoles(dataDir);
    const role = clean(args.role);
    if (!role) throw new Error('bridge spawn: role is required');
    const roleCfg = roles.get(role);
    const { presetName, preset } = resolvePreset(config, args, roleCfg);
    await ensureProvider(config, preset.provider);

    const tag = clean(args.tag) || nextTag(role);
    if (tags.has(tag)) throw new Error(`bridge spawn: tag "${tag}" already exists`);
    const workerCwd = clean(args.cwd) ? resolve(args.cwd) : defaultCwd;
    const prompt = withCwdHeader(await resolvePrompt(args, workerCwd), workerCwd);
    const runtimeSpec = cfgMod.resolveRuntimeSpec(preset, { lane: 'bridge', agentId: tag });
    const session = mgr.createSession({
      provider: preset.provider,
      model: preset.model,
      preset,
      owner: 'bridge',
      lane: runtimeSpec.lane,
      scopeKey: runtimeSpec.scopeKey,
      role,
      sourceType: 'cli',
      sourceName: role,
      bridgeTag: tag,
      permission: normalizePermission(roleCfg?.permission) || 'full',
      cwd: workerCwd,
      skipSkills: true,
    });
    tags.set(tag, session.id);
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
  }

  async function send(args) {
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('bridge send: tag or sessionId is required');
    const sessionId = resolveTag(target);
    if (!sessionId) throw new Error(`bridge send: target "${target}" not found`);
    const session = mgr.getSession(sessionId);
    if (!session || session.closed) throw new Error(`bridge send: session "${sessionId}" is closed`);
    const prompt = await resolvePrompt(args, session.cwd || defaultCwd);
    const result = await mgr.askSession(sessionId, prompt, args.context || null, null, session.cwd || defaultCwd);
    return {
      tag: tagForSession(sessionId),
      sessionId,
      role: session.role || null,
      provider: session.provider,
      model: session.model,
      content: result?.content || '',
    };
  }

  function close(args) {
    const target = clean(args.tag || args.sessionId);
    if (!target) throw new Error('bridge close: tag or sessionId is required');
    const sessionId = resolveTag(target);
    if (!sessionId) throw new Error(`bridge close: target "${target}" not found`);
    const tag = tagForSession(sessionId);
    if (tag) tags.delete(tag);
    const ok = mgr.closeSession(sessionId, 'cli-bridge-close');
    return { closed: ok, tag, sessionId };
  }

  async function execute(args = {}) {
    const type = clean(args.type) || 'spawn';
    if (type === 'list') return renderResult({ workers: list() });
    if (type === 'close') return renderResult(close(args));
    if (type === 'send') return renderResult(await send(args));
    if (type === 'spawn') return renderResult(await spawn(args));
    throw new Error(`bridge: unknown type "${type}"`);
  }

  return { tools: [BRIDGE_TOOL], execute };
}
