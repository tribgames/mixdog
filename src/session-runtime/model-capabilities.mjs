// Provider/model capability probes: fast-tier + hosted web-search support, and
// model-settings persistence. Pure except saveModelSettings (takes cfgMod).
import { clean, hasOwn } from './session-text.mjs';

const FAST_CAPABLE_PROVIDERS = new Set(['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth']);
export const LAZY_SECRET_PROVIDERS = new Set(['openai-oauth', 'anthropic-oauth', 'grok-oauth', 'ollama', 'lmstudio']);

export function routeFastKey(provider, model) {
  const p = clean(provider);
  const m = clean(model);
  return p && m ? `${p}/${m}` : '';
}

function openAiModelMetaSupportsFast(model) {
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  const speedTiers = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
  if (tiers.length || speedTiers.length || model?.defaultServiceTier) {
    return tiers.some((tier) => tier?.id === 'priority')
      || speedTiers.includes('priority')
      || model?.defaultServiceTier === 'priority';
  }
  const id = clean(model?.id || model).toLowerCase();
  if (id.includes('mini') || id.includes('nano') || id.includes('codex')) return false;
  return /^gpt-5(\.|-|$)/.test(id);
}

function openAiDirectModelSupportsFast(model) {
  const id = clean(model?.id || model);
  return /^gpt-5\.5(?:-\d{4}|$)/.test(id)
    || /^gpt-5\.4(?:-\d{4}|$)/.test(id)
    || /^gpt-5\.4-mini(?:-\d{4}|$)/.test(id);
}

function openAiModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id) return false;
  if (model?.supportsWebSearch === true) return true;
  const tools = [
    ...(Array.isArray(model?.supportedTools) ? model.supportedTools : []),
    ...(Array.isArray(model?.tools) ? model.tools : []),
    ...(Array.isArray(model?.capabilities?.tools) ? model.capabilities.tools : []),
  ].map((tool) => clean(tool?.type || tool?.name || tool).toLowerCase());
  if (tools.some((tool) => tool === 'web_search' || tool === 'web_search_preview')) return true;
  if (/codex|image|audio|tts|stt|embedding|rerank|moderation|search-preview/.test(id)) return false;
  return /^gpt-(5(?:\.|$|-)|4\.1(?:-|$)|4o(?:-|$)|4\.5(?:-|$))/.test(id)
    || /^o[34](?:-|$)/.test(id);
}

function grokModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id || /imagine|image|video|composer/.test(id)) return false;
  if (id === 'grok-build') return false;
  return /^grok-/.test(id);
}

function geminiModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id || /embedding|aqa|imagen|veo|tts|image|computer-use|customtools/.test(id)) return false;
  return /^gemini-(3(?:\.|-|$)|2\.5-|2\.0-flash)/.test(id);
}

function anthropicModelSupportsHostedWebSearch(model) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id) return false;
  const match = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/);
  if (!match) return false;
  const major = Number(match[2]) || 0;
  const minor = Number(match[3]) || 0;
  return major > 4 || (major === 4 && minor >= 0);
}

function anthropicModelMetaSupportsFast(model) {
  const id = clean(model?.id || model).toLowerCase();
  return /^claude-(opus|sonnet)/.test(id);
}

export function fastCapableFor(provider, model) {
  const p = clean(provider);
  if (!FAST_CAPABLE_PROVIDERS.has(p)) return false;
  if (p === 'openai') return openAiDirectModelSupportsFast(model);
  if (p === 'openai-oauth') return openAiModelMetaSupportsFast(model);
  if (p === 'anthropic' || p === 'anthropic-oauth') return anthropicModelMetaSupportsFast(model);
  return false;
}

// searchCapableFor needs the search-route normalizers, which live in
// search-routes.mjs and themselves are pure. Wire them in via a factory to keep
// this module free of a circular import at load time.
export function makeSearchCapableFor(normalizeSearchProviderId, isSearchCapableProvider) {
  return function searchCapableFor(provider, model) {
    const p = normalizeSearchProviderId(provider);
    if (!isSearchCapableProvider(p)) return false;
    if (p === 'openai' || p === 'openai-oauth') return openAiModelSupportsHostedWebSearch(model);
    if (p === 'grok-oauth' || p === 'xai') return grokModelSupportsHostedWebSearch(model);
    if (p === 'gemini') return geminiModelSupportsHostedWebSearch(model);
    if (p === 'anthropic' || p === 'anthropic-oauth') return anthropicModelSupportsHostedWebSearch(model);
    return model?.supportsWebSearch === true;
  };
}

export function fastPreferenceFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  if (!key) return false;
  const saved = config?.modelSettings?.[key];
  if (saved && typeof saved === 'object' && hasOwn(saved, 'fast')) return saved.fast === true;
  return config?.fastModels?.[key] === true;
}

export function saveModelSettings(cfgMod, route, { fastCapable = true, baseConfig = null } = {}) {
  const key = routeFastKey(route?.provider, route?.model);
  if (!key) return baseConfig || cfgMod.loadConfig();
  const nextConfig = baseConfig || cfgMod.loadConfig();
  const modelSettings = { ...(nextConfig.modelSettings || {}) };
  const nextSetting = { ...(modelSettings[key] || {}) };
  if (hasOwn(route, 'effort') && route.effort) nextSetting.effort = route.effort;
  else delete nextSetting.effort;
  if (fastCapable) nextSetting.fast = route.fast === true;
  else nextSetting.fast = false;
  modelSettings[key] = nextSetting;

  // Legacy compatibility: keep fastModels true entries for old readers, but
  // let modelSettings.fast=false override them in new readers.
  const fastModels = { ...(nextConfig.fastModels || {}) };
  if (nextSetting.fast === true) fastModels[key] = true;
  else delete fastModels[key];

  const savedConfig = { ...nextConfig, modelSettings, fastModels };
  cfgMod.saveConfig(savedConfig);
  return savedConfig;
}
