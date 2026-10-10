// Preset normalization and identity are independent of config storage.
import { isDeepStrictEqual } from 'node:util';

const ANTHROPIC_FAMILY_MODEL = Object.freeze({
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
});

function resolveAnthropicFamilyModel(family) {
  const key = String(family || '').toLowerCase();
  if (!key) return null;
  const envVar = `ANTHROPIC_DEFAULT_${key.toUpperCase()}_MODEL`;
  if (process.env[envVar]) return process.env[envVar];
  return ANTHROPIC_FAMILY_MODEL[key] || null;
}

export const DEFAULT_MAINTENANCE = Object.freeze({
  webhook: { provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('haiku') },
});

export const DEFAULT_PRESETS = Object.freeze([
  Object.freeze({
    id: 'haiku',
    name: 'HAIKU',
    type: 'agent',
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('haiku'),
    tools: 'full',
  }),
  Object.freeze({
    id: 'sonnet-mid',
    name: 'SONNET MID',
    type: 'agent',
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('sonnet'),
    effort: 'medium',
    tools: 'full',
  }),
  Object.freeze({
    id: 'sonnet-high',
    name: 'SONNET HIGH',
    type: 'agent',
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('sonnet'),
    effort: 'high',
    tools: 'full',
  }),
  Object.freeze({
    id: 'opus-mid',
    name: 'OPUS MID',
    type: 'agent',
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('opus'),
    effort: 'medium',
    tools: 'full',
  }),
  Object.freeze({
    id: 'opus-high',
    name: 'OPUS HIGH',
    type: 'agent',
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('opus'),
    effort: 'high',
    tools: 'full',
  }),
]);

const DEFAULT_PRESET_BY_ID = new Map(DEFAULT_PRESETS.map((preset) => [preset.id, preset]));

/** Effective presets: the stored entries in their stored order, then the
 *  shipped presets missing from storage in shipped order. */
export function withDefaultPresets(stored) {
  const list = Array.isArray(stored) ? stored : [];
  const present = new Set(list.map(presetKey));
  return [...list, ...DEFAULT_PRESETS.filter((preset) => !present.has(preset.id)).map((preset) => ({ ...preset }))];
}

/** Stored form of `presets`: only entries that differ from the shipped default of the same id. */
export function presetsDelta(presets) {
  return (Array.isArray(presets) ? presets : []).filter((preset) => {
    const shipped = DEFAULT_PRESET_BY_ID.get(presetKey(preset));
    return !shipped || !isDeepStrictEqual(normalizePreset(preset), { ...shipped });
  });
}

/** Stored form of `maintenance`: only slots that differ from the shipped route. */
export function maintenanceDelta(maintenance) {
  const source = maintenance && typeof maintenance === 'object' ? maintenance : {};
  return Object.fromEntries(
    Object.entries(source).filter(([slot, route]) => !isDeepStrictEqual(route, DEFAULT_MAINTENANCE[slot]))
  );
}

const AGENT_PROVIDER_ALIASES = Object.freeze({
  'openai-api': 'openai',
  'gemini-api': 'gemini',
  'xai-api': 'xai',
});
const FAST_CAPABLE_PRESET_PROVIDERS = new Set([
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-oauth',
  'cursor-oauth',
  'cursor-api',
]);

export function normalizeAgentProviderId(provider) {
  const id = String(provider || '').trim();
  return AGENT_PROVIDER_ALIASES[id] || id;
}

function presetKey(p) {
  return p?.id || p?.name || '';
}

export function normalizePreset(preset) {
  if (!preset || typeof preset !== 'object') return null;
  const id = String(preset.id || preset.name || '').trim();
  const name = String(preset.name || preset.id || '').trim();
  const model = String(preset.model || '').trim();
  const provider = normalizeAgentProviderId(preset.provider);
  if (!name || !model || !provider) return null;
  const out = { id, name, type: 'agent', provider, model };
  if (preset.effort) out.effort = String(preset.effort).trim();
  if (preset.fast === true && FAST_CAPABLE_PRESET_PROVIDERS.has(provider)) out.fast = true;
  out.tools = ['full', 'readonly', 'mcp'].includes(preset.tools) ? preset.tools : 'full';
  return out;
}

export function getPreset(config, key) {
  const presets = listPresets(config);
  if (key == null || key === '') return null;
  if (typeof key === 'number' || /^\d+$/.test(String(key))) {
    const idx = Number(key);
    return presets[idx] || null;
  }
  return presets.find((p) => p && presetKey(p) === key) || null;
}

export function getDefaultPreset(config) {
  if (!config?.default) return null;
  return getPreset(config, config.default);
}

export function listPresets(config) {
  return Array.isArray(config?.presets) ? config.presets : [];
}

// Effort/fast changes share a session; role, provider, or model changes do not.
export function resolveRuntimeSpec(preset, ctx) {
  const lane = ctx.lane || 'agent';
  const provider = String(preset?.provider || '').trim() || 'unknown';
  const model = String(preset?.model || '').trim() || '_';
  let scopeKey;
  if (lane === 'agent') {
    if (!ctx.agentId) throw new Error('agent lane requires agentId');
    scopeKey = `agent:${ctx.agentId}:${provider}:${model}`;
  } else {
    scopeKey = `agent:${provider}:${model}`;
  }
  return { lane, scopeKey, reuse: true, preset };
}
