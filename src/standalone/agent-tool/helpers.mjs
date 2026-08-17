// Dependency-light helpers extracted from the agent-tool facade.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  normalizeAgentPermissionOrNone,
  parseMarkdownFrontmatter,
} from '../../runtime/shared/markdown-frontmatter.mjs';
import {
  clearGatewaySessionRoute,
  writeGatewaySessionRoutes,
} from '../../vendor/statusline/src/gateway/session-routes.mjs';
import { PRESET_ALIASES } from './tool-def.mjs';

export function envTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function agentTagOf(session) {
  return clean(session?.agentTag);
}

export function normalizeAgentName(value) {
  const id = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  if (id === 'heavy' || id === 'heavyworker') return 'heavy-worker';
  if (id === 'review') return 'reviewer';
  return id;
}

export function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function terminalPidForContext(context = {}) {
  return positiveInt(context?.clientHostPid);
}

export function agentScope(args = {}, context = {}) {
  const scope = clean(args.scope || args.terminal || args.term).toLowerCase();
  if (args.allTerminals === true || scope === 'all' || scope === 'global') return {};
  return context || {};
}

export function callerSessionForContext(context = {}) {
  return clean(context?.callerSessionId || context?.routingSessionId) || null;
}

// Agents are session-owned: when the caller context carries a session id, the
// scope is that OWNER SESSION, strictly — a shard/host process can run many
// Lead sessions on one clientHostPid, so pid matching alone leaks siblings.
// Without a caller session id (legacy/terminal contexts), pid scoping remains.
export function sessionMatchesContext(session, context = {}) {
  const wantedSession = callerSessionForContext(context);
  if (wantedSession) {
    return clean(session?.ownerSessionId || session?.parentSessionId) === wantedSession;
  }
  const wantedPid = terminalPidForContext(context);
  if (!wantedPid) return true;
  const sessionPid = positiveInt(session?.clientHostPid);
  return !!sessionPid && sessionPid === wantedPid;
}

export function rowMatchesContext(row, context = {}) {
  const wantedSession = callerSessionForContext(context);
  if (wantedSession) return clean(row?.ownerSessionId) === wantedSession;
  const wantedPid = terminalPidForContext(context);
  if (!wantedPid) return true;
  const rowPid = positiveInt(row?.clientHostPid);
  return !!rowPid && rowPid === wantedPid;
}

export function nonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function presetKey(preset) {
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

const pendingAgentStatuslineRoutes = new Map();
let pendingAgentStatuslineRouteFlush = null;

export function flushAgentStatuslineRoutes() {
  if (pendingAgentStatuslineRouteFlush) {
    clearImmediate(pendingAgentStatuslineRouteFlush);
    pendingAgentStatuslineRouteFlush = null;
  }
  if (pendingAgentStatuslineRoutes.size === 0) return false;
  const entries = [...pendingAgentStatuslineRoutes.values()];
  pendingAgentStatuslineRoutes.clear();
  try { return writeGatewaySessionRoutes(entries); } catch { return false; }
}

export function writeAgentStatuslineRoute(sessionId, preset) {
  const route = bridgeRouteForStatusline(preset);
  if (!sessionId || !route) return false;
  pendingAgentStatuslineRoutes.set(sessionId, { sessionId, route });
  if (!pendingAgentStatuslineRouteFlush) {
    pendingAgentStatuslineRouteFlush = setImmediate(flushAgentStatuslineRoutes);
  }
  return true;
}

export function clearAgentStatuslineRoute(sessionId) {
  if (!sessionId) return false;
  pendingAgentStatuslineRoutes.delete(sessionId);
  try { return clearGatewaySessionRoute(sessionId); } catch { return false; }
}

export function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    return clean(p?.id).toLowerCase() === wanted || clean(p?.name).toLowerCase() === wanted;
  }) || null;
}

export function synthesizePreset(config, key) {
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

export function normalizeAgentRoute(routeLike) {
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

export function agentPresetName(agent) {
  return `AGENT ${String(agent || '').toUpperCase()}`;
}

export async function resolvePrompt(args, cwd) {
  const promptValue = args.prompt !== undefined ? args.prompt : args.message;
  if (promptValue !== undefined && typeof promptValue !== 'string') {
    throw new TypeError('agent: prompt/message must be a string');
  }
  if (args.file !== undefined && typeof args.file !== 'string') {
    throw new TypeError('agent: file must be a string');
  }
  const prompt = promptValue?.trim() || '';
  const file = args.file?.trim() || '';
  if (prompt && file) throw new Error('agent: provide only one of prompt/message or file');
  if (prompt) return prompt;
  if (file) {
    const target = isAbsolute(file) ? file : resolve(cwd || process.cwd(), file);
    return readFileSync(target, 'utf8');
  }
  throw new Error('agent: prompt/message/file is required');
}

export function compactIso(value) {
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

export function elapsedFromStamps(startedAt, finishedAt, status) {
  const start = Date.parse(clean(startedAt));
  if (!Number.isFinite(start)) return null;
  const finish = Date.parse(clean(finishedAt));
  const end = Number.isFinite(finish) ? finish : Date.now();
  const label = formatElapsedMs(end - start);
  if (!label) return null;
  return Number.isFinite(finish) ? label : `${label} (running)`;
}

export function stripFinalAnswerWrapper(value) {
  const text = String(value ?? '').trim();
  const match = /^<final-answer\b[^>]*>([\s\S]*?)<\/final-answer>\s*$/i.exec(text);
  return match ? match[1].trim() : text;
}

// Process-wide TTL cache for agent AGENT.md frontmatter permission. The file
// rarely changes, but this otherwise pays several existsSync()+readFileSync()
// calls on EVERY spawn — multiplied across a parallel fanout that is pure
// redundant synchronous I/O on the event loop, which blocks every other
// concurrent spawn. Short TTL keeps edits picked up quickly while collapsing
// burst reads. Cache + TTL are owned here alongside the sole reader.
const _frontmatterPermCache = new Map(); // key -> { value, atMs }
const FRONTMATTER_PERM_CACHE_TTL_MS = envTimeoutMs('MIXDOG_AGENT_FRONTMATTER_TTL_MS', 5_000);

export function readAgentFrontmatterPermission(agent, dataDir, standaloneSourceRoot) {
  const cleanAgent = clean(agent);
  if (!cleanAgent) return null;
  if (dataDir && existsSync(join(dataDir, 'agents', cleanAgent, '.deleted'))) return null;
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
  candidates.push(join(standaloneSourceRoot, 'agents', cleanAgent, 'AGENT.md'));
  candidates.push(join(standaloneSourceRoot, 'agents', `${cleanAgent}.md`));
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

// Agents are global definitions (agents/<id>/ under the data dir or the
// shipped source root). A spawn of an id with no definition anywhere —
// typically a custom agent deleted in settings — must fail loudly instead of
// silently running as a role-less generic agent.
export function agentDefinitionExists(agent, dataDir, standaloneSourceRoot) {
  const cleanAgent = clean(agent);
  if (!cleanAgent) return false;
  if (dataDir && existsSync(join(dataDir, 'agents', cleanAgent, '.deleted'))) return false;
  const candidates = [];
  if (dataDir) {
    candidates.push(join(dataDir, 'agents', cleanAgent, 'AGENT.md'));
    candidates.push(join(dataDir, 'agents', `${cleanAgent}.md`));
  }
  candidates.push(join(standaloneSourceRoot, 'agents', cleanAgent, 'AGENT.md'));
  candidates.push(join(standaloneSourceRoot, 'agents', `${cleanAgent}.md`));
  return candidates.some((file) => existsSync(file));
}
