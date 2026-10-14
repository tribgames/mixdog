// Provider/model capability probes: fast-tier + hosted web-search support, and
// in-memory model-settings updates. saveModelSettings returns the next config;
// callers persist via saveConfigAndAdopt so a new-task setWorkflow debounce
// never collides with a sync mixdog-config lock (ELOCKCONTENDED).
import { clean, hasOwn } from './session-text.mjs';
import { modelSupportsServiceTier } from '../providers/model-service-tiers.mjs';
import { openAiDirectSupportsFast, openAiDirectSupportsUltrafast } from '../providers/openai-direct-request.mjs';
import { supportsAnthropicFastMode } from '../../../shared/llm/anthropic-betas.mjs';
import { normalizeContextTokens } from '../../../shared/llm/default-context-window.mjs';
import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';

const FAST_CAPABLE_PROVIDERS = new Set([
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-oauth',
  'cursor-oauth',
  'cursor-api',
]);
export const LAZY_SECRET_PROVIDERS = new Set(['openai-oauth', 'anthropic-oauth', 'grok-oauth']);

export function routeFastKey(provider, model) {
  const p = clean(provider);
  const m = clean(model);
  return p && m ? `${p}/${m}` : '';
}

// What one catalog row states about hosted web search: its own
// `supportsWebSearch` flag (true or false), else a web_search tool in its tool
// lists. Null when the row says nothing, which leaves the answer to the id
// fallback of each family.
function rowWebSearchDeclaration(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.supportsWebSearch === 'boolean') return row.supportsWebSearch;
  const tools = [
    ...(Array.isArray(row.supportedTools) ? row.supportedTools : []),
    ...(Array.isArray(row.tools) ? row.tools : []),
    ...(Array.isArray(row.capabilities?.tools) ? row.capabilities.tools : []),
  ].map((tool) => clean(tool?.type || tool?.name || tool).toLowerCase());
  return tools.some((tool) => tool === 'web_search' || tool === 'web_search_preview') ? true : null;
}

// The route's own row first, then the provider catalog's row for the model.
function hostedWebSearchDeclared(model, catalogRow) {
  return rowWebSearchDeclaration(model) ?? rowWebSearchDeclaration(catalogRow);
}

// When neither the route row nor the catalog states hosted web search, the
// vendor family (already fixed by the provider) is taken as capable unless the
// id names a non-chat modality or a retired generation. Only those closed,
// frozen sets are matched by id, so a model released later needs no entry here;
// guessing "capable" wrongly would hard-fail the request, which is why the
// retired generations stay excluded.
function hostedWebSearchFallback(model, catalogRow, unsupportedId) {
  const id = clean(model?.id || model).toLowerCase();
  if (!id) return false;
  const declared = hostedWebSearchDeclared(model, catalogRow);
  if (declared !== null) return declared;
  return !unsupportedId.test(id);
}

const NON_CHAT_ID = 'embedding|rerank|moderation|image|imagen|imagine|video|veo|audio|tts|stt|aqa|search-preview';

const OPENAI_UNSUPPORTED = new RegExp(
  `${NON_CHAT_ID}|codex|^gpt-(?:3|4(?:$|-))|^o[12](?:-|$)|^(?:babbage|davinci|text-)`
);
const GROK_UNSUPPORTED = new RegExp(`${NON_CHAT_ID}|composer|^grok-build$|^grok-[123](?:[.-]|$)`);
// The Gemini family is also reached through a relay serving other vendors'
// models, whose hosted search is Gemini's alone, so a non-Gemini id is out.
const GEMINI_UNSUPPORTED = new RegExp(
  `${NON_CHAT_ID}|^(?!gemini-)|computer-use|customtools|^gemini-(?:1[.-]|pro|ultra)|^gemini-2\\.0-(?!flash)`
);
const ANTHROPIC_UNSUPPORTED = /^claude-(?:\d|instant)|^claude-[a-z]+-[123](?:[-.]|$)/;

const openAiModelSupportsHostedWebSearch = (model, row) => hostedWebSearchFallback(model, row, OPENAI_UNSUPPORTED);
const grokModelSupportsHostedWebSearch = (model, row) => hostedWebSearchFallback(model, row, GROK_UNSUPPORTED);
const geminiModelSupportsHostedWebSearch = (model, row) => hostedWebSearchFallback(model, row, GEMINI_UNSUPPORTED);
const anthropicModelSupportsHostedWebSearch = (model, row) =>
  hostedWebSearchFallback(model, row, ANTHROPIC_UNSUPPORTED);

export function fastCapableFor(provider, model, effort = null, modelParameters = {}) {
  const p = clean(provider);
  if (!FAST_CAPABLE_PROVIDERS.has(p)) return false;
  if (p === 'cursor-oauth' || p === 'cursor-api') {
    const fastEfforts = Array.isArray(model?.fastEfforts) ? model.fastEfforts.map(clean) : [];
    if (model?.fastCapable !== true && fastEfforts.length === 0) return false;
    const selectedEffort = clean(effort);
    if (Array.isArray(model?.parameterVariants) && model.parameterVariants.length) {
      const parameters = modelParameters && typeof modelParameters === 'object' ? modelParameters : {};
      return model.parameterVariants.some(
        (variant) =>
          variant?.fast === 'true' &&
          (!selectedEffort || !variant.effort || clean(variant.effort) === selectedEffort) &&
          Object.entries(parameters).every(([key, value]) => !variant?.[key] || clean(variant[key]) === clean(value))
      );
    }
    return !selectedEffort || fastEfforts.length === 0 || fastEfforts.includes(selectedEffort);
  }
  if (p === 'openai-oauth') return modelSupportsServiceTier(model, 'priority');
  // The route row's own declaration first, then the catalog via the helpers.
  if (typeof model?.supportsFastMode === 'boolean') return model.supportsFastMode;
  const modelId = clean(model?.id || model);
  const declaredFast = modelId ? getModelMetadataSync(modelId, p)?.supportsFastMode : undefined;
  if (typeof declaredFast === 'boolean') return declaredFast;
  if (p === 'openai') return openAiDirectSupportsFast(model);
  if (p === 'anthropic' || p === 'anthropic-oauth') return supportsAnthropicFastMode(clean(model?.id || model));
  return false;
}

export function ultrafastCapableFor(provider, model) {
  const p = clean(provider);
  if (p === 'openai') return openAiDirectSupportsUltrafast(model);
  if (p === 'openai-oauth') return modelSupportsServiceTier(model, 'ultrafast');
  return false;
}

const HOSTED_WEB_SEARCH_BY_FAMILY = {
  openai: openAiModelSupportsHostedWebSearch,
  xai: grokModelSupportsHostedWebSearch,
  gemini: geminiModelSupportsHostedWebSearch,
  anthropic: anthropicModelSupportsHostedWebSearch,
};

// webSearchCapableFor needs the web-search family mapping, which lives in
// workflow.mjs and is pure. Wire it in via a factory to keep this module free
// of a circular import at load time.
// `catalogRowFor(provider, id)` is the provider catalog's row for the model;
// callers that hold only a bare id (or a row the provider list left silent)
// still get the catalog's answer before the id fallback applies.
export function makeWebSearchCapableFor(webSearchProviderFamily, catalogRowFor = getModelMetadataSync) {
  return function webSearchCapableFor(provider, model) {
    const supports = HOSTED_WEB_SEARCH_BY_FAMILY[webSearchProviderFamily(provider)];
    if (!supports) return false;
    const id = clean(model?.id || model);
    return supports(model, id ? catalogRowFor(id, provider) : null);
  };
}

export function fastPreferenceFor(config, provider, model) {
  const key = routeFastKey(provider, model);
  if (!key) return false;
  const saved = config?.modelSettings?.[key];
  return Boolean(saved && typeof saved === 'object' && saved.fast === true);
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
  // Auto effort is on unless turned off: only the off state is stored.
  if (hasOwn(route, 'autoEffort')) {
    if (route.autoEffort === false) nextSetting.autoEffort = false;
    else delete nextSetting.autoEffort;
  }
  if (route.modelParameters && typeof route.modelParameters === 'object') {
    nextSetting.modelParameters = Object.fromEntries(
      Object.entries(route.modelParameters)
        .map(([key, value]) => [clean(key), clean(value)])
        .filter(([key, value]) => key && value)
    );
  } else {
    delete nextSetting.modelParameters;
  }
  // Only a window the user moved off the model's default is a setting. The
  // pickers send the default stop with every selection; storing it froze each
  // model at whatever its default was that day, so a later default never
  // reached anyone who had already selected the model.
  // An exact window in tokens replaces the percentage, and a percentage
  // replaces it. A token selection at the default window reaches here already
  // dropped (resolveRouteContextState answers no contextTokens for it).
  const contextTokens = normalizeContextTokens(route.contextTokens);
  const requestedPercent = Number(route.contextPercent);
  const contextPercent = Math.round(requestedPercent / 10) * 10;
  const isDefault = contextPercent === Number(route.contextDefaultPercent);
  if (contextTokens) {
    nextSetting.contextTokens = contextTokens;
    delete nextSetting.contextPercent;
  } else if (requestedPercent >= 10 && requestedPercent <= 100 && !isDefault) {
    nextSetting.contextPercent = contextPercent;
    delete nextSetting.contextTokens;
  } else {
    delete nextSetting.contextPercent;
    delete nextSetting.contextTokens;
  }
  modelSettings[key] = nextSetting;

  const savedConfig = { ...nextConfig, modelSettings };
  return savedConfig;
}
