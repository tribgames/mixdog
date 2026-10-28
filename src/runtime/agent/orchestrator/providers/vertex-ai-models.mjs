import { geminiBareModelId } from './gemini-cache-policy.mjs';

// Vertex AI model catalog and per-model endpoint rules (checked 2026-10-28):
// - Gemini lifecycle: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
// - Claude ids: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude
// - Partner endpoints: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/use-partner-models
// - Open models (MaaS): https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models
// - Flex / Priority PayGo: .../models/flex-paygo, .../models/priority-paygo
// - Pricing: https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing

export const VERTEX_SERVICE_TIER_PARAMETER = 'serviceTier';
export const VERTEX_FLEX_TIER = 'flex';
export const VERTEX_PRIORITY_TIER = 'priority';

// Multi-region locations, served by representative endpoints.
export const VERTEX_MULTI_REGIONS = new Set(['us', 'eu']);
const PRIORITY_LOCATIONS = new Set(['global', 'us', 'eu']);

// Flex PayGo: global endpoint only.
const FLEX_MODELS = new Set([
  'gemini-3.8-flash-cyber',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
]);

// Priority PayGo: global, us and eu endpoints (retired Gemini 2.5 left out).
const PRIORITY_MODELS = new Set([
  'gemini-4-argon',
  'gemini-4-argon-cyber-permissive',
  'gemini-3.8-flash-cyber',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
]);

// Generally available Gemini 3+ models billed 10% above the global rate on
// regional and multi-region endpoints since 2026-07-01 (the pricing page's
// "Non-global" rows). Preview models carry global rates only.
const REGIONAL_PREMIUM_GEMINI = new Set([
  'gemini-4-argon',
  'gemini-4-argon-cyber-permissive',
  'gemini-3.8-flash-cyber',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

// Vertex bills Claude and the Gemini models above on regional and multi-region
// endpoints 10% above the global list price; such requests carry this pricing
// SKU suffix (model-catalog.mjs prices it from the base SKU).
export const VERTEX_REGIONAL_PRICING_SUFFIX = '@regional';

const google = (id, name, contextWindow) => ({ id, name, ...(contextWindow ? { contextWindow } : {}) });
const claude = (id, name, family, contextWindow) => ({
  id,
  name,
  family,
  ...(contextWindow ? { contextWindow } : {}),
});
// Open and partner models on the OpenAI-compatible endpoint. `locations` is
// the model card's availability (checked 2026-10-28); a listed model is sent
// only there. A model with no documented locations is not listed (it stays
// usable as a free-form id, which is not checked).
const open = (id, name, locations) => ({ id, name, locations });

export const VERTEX_MODELS = Object.freeze([
  google('gemini-4-argon', 'Gemini 4 Argon', 1048576),
  google('gemini-4-argon-cyber-permissive', 'Gemini 4 Argon Cyber Permissive'),
  google('gemini-3.8-flash', 'Gemini 3.8 Flash', 1048576),
  google('gemini-3.8-flash-cyber', 'Gemini 3.8 Flash Cyber'),
  google('gemini-3.7-flash', 'Gemini 3.7 Flash'),
  google('gemini-3.6-flash', 'Gemini 3.6 Flash'),
  google('gemini-3.5-flash', 'Gemini 3.5 Flash'),
  google('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 1048576),
  google('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite'),
  google('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1048576),
  google('gemini-3-flash-preview', 'Gemini 3 Flash Preview'),
  claude('claude-opus-5-5', 'Claude Opus 5.5', 'opus', 1000000),
  claude('claude-fable-5-1', 'Claude Fable 5.1', 'fable', 1000000),
  claude('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'sonnet', 1000000),
  claude('claude-haiku-5-5', 'Claude Haiku 5.5', 'haiku'),
  claude('claude-opus-5', 'Claude Opus 5', 'opus'),
  claude('claude-fable-5', 'Claude Fable 5', 'fable'),
  claude('claude-sonnet-5', 'Claude Sonnet 5', 'sonnet'),
  claude('claude-opus-4-8', 'Claude Opus 4.8', 'opus'),
  claude('claude-opus-4-7', 'Claude Opus 4.7', 'opus'),
  claude('claude-opus-4-6', 'Claude Opus 4.6', 'opus'),
  claude('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'sonnet'),
  claude('claude-opus-4-5', 'Claude Opus 4.5', 'opus'),
  claude('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'sonnet'),
  claude('claude-haiku-4-5', 'Claude Haiku 4.5', 'haiku'),
  claude('claude-3-7-sonnet', 'Claude 3.7 Sonnet', 'sonnet'),
  claude('claude-3-5-sonnet-v2', 'Claude 3.5 Sonnet v2', 'sonnet'),
  claude('claude-3-5-sonnet', 'Claude 3.5 Sonnet', 'sonnet'),
  claude('claude-3-5-haiku', 'Claude 3.5 Haiku', 'haiku'),
  open('deepseek-ai/deepseek-v4.1-flash-maas', 'DeepSeek V4.1 Flash', ['global']),
  open('deepseek-ai/deepseek-v3.2-maas', 'DeepSeek V3.2', ['global']),
  open('deepseek-ai/deepseek-v3.1-maas', 'DeepSeek V3.1', ['us-central1']),
  open('deepseek-ai/deepseek-r1-0528-maas', 'DeepSeek R1 (0528)', ['us-central1']),
  open('qwen/qwen3-coder-480b-a35b-instruct-maas', 'Qwen3 Coder', ['global', 'us-south1']),
  open('qwen/qwen3-next-80b-a3b-instruct-maas', 'Qwen3-Next 80B Instruct', ['global']),
  open('qwen/qwen3-next-80b-a3b-thinking-maas', 'Qwen3-Next 80B Thinking', ['global']),
  open('zai-org/glm-5.2-maas', 'GLM 5.2', ['global']),
  open('zai-org/glm-5-maas', 'GLM 5', ['global']),
  open('zai-org/glm-4.7-maas', 'GLM 4.7', ['global']),
  open('moonshotai/kimi-k2-thinking-maas', 'Kimi K2 Thinking', ['global']),
  open('minimaxai/minimax-m2-maas', 'MiniMax M2', ['global']),
  // Card: availability `global`, quotas for `global` and `us-central1`.
  open('openai/gpt-oss-120b-maas', 'gpt-oss 120B', ['global', 'us-central1']),
  open('openai/gpt-oss-20b-maas', 'gpt-oss 20B', ['us-central1']),
  open('meta/llama-4-maverick-17b-128e-instruct-maas', 'Llama 4 Maverick 17B-128E', ['us-east5']),
  open('meta/llama-4-scout-17b-16e-instruct-maas', 'Llama 4 Scout 17B-16E', ['us-east5']),
  open('google/gemma-4-26b-a4b-it-maas', 'Gemma 4 26B A4B IT', ['global']),
  open('xai/grok-4.7', 'Grok 4.7', ['global', 'us']),
  open('xai/grok-4.6', 'Grok 4.6', ['global', 'us']),
  open('xai/grok-4.3', 'Grok 4.3', ['global']),
  open('xai/grok-4.20-reasoning', 'Grok 4.20 (Reasoning)', ['global']),
  open('xai/grok-4.20-non-reasoning', 'Grok 4.20 (Non-reasoning)', ['global']),
]);

const LISTED_LOCATIONS = new Map(VERTEX_MODELS.filter((model) => model.locations).map((model) => [model.id, model.locations]));

const PUBLISHER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

/**
 * The publisher, model id and wire of a model: `gemini` (generateContent),
 * `claude` (Anthropic rawPredict) or `maas` (the OpenAI-compatible endpoint
 * every other publisher, and Google's `-maas` open models, answer on).
 * Accepts `publishers/P/models/M`, `P/M` and the bare Gemini / Claude / Grok ids.
 */
export function vertexRoute(model) {
  const raw = String(model || '').trim();
  if (!raw) throw new Error('[vertex-ai] model is required');
  const path = /^publishers\/([^/]+)\/models\/([^/]+)$/.exec(raw) || /^([^/]+)\/([^/]+)$/.exec(raw);
  let publisher;
  let id;
  if (path) {
    publisher = path[1].toLowerCase();
    id = path[2];
  } else if (/^gemini-/i.test(raw)) {
    publisher = 'google';
    id = geminiBareModelId(raw);
  } else if (/^claude-/i.test(raw)) {
    publisher = 'anthropic';
    id = raw;
  } else if (/^grok-/i.test(raw)) {
    publisher = 'xai';
    id = raw;
  } else {
    throw new Error(
      `[vertex-ai] cannot determine the publisher of model "${raw}"; use "publisher/model" (for example "deepseek-ai/deepseek-v3.2-maas")`
    );
  }
  if (!PUBLISHER.test(publisher) || !MODEL_ID.test(id)) throw new Error(`[vertex-ai] model "${raw}" is invalid`);
  const wire = publisher === 'anthropic' ? 'claude' : publisher === 'google' && !/-maas$/i.test(id) ? 'gemini' : 'maas';
  return { publisher, id, wire };
}

// [major, minor] of a Claude id (claude-opus-4-8, claude-sonnet-5, claude-3-7-sonnet), or null.
function claudeVersion(id) {
  const bare = String(id).replace(/@.*$/, '');
  const match = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(bare) || /^claude-(\d+)(?:-(\d{1,2}))?-[a-z]/.exec(bare);
  return match ? [Number(match[1]), Number(match[2] || 0)] : null;
}

/** The PayGo tier a send asks for: 'flex', 'priority' or '' (standard). */
export function vertexRequestedTier(opts) {
  const tier = String(opts?.modelParameters?.[VERTEX_SERVICE_TIER_PARAMETER] || '').toLowerCase();
  return tier === VERTEX_FLEX_TIER || tier === VERTEX_PRIORITY_TIER ? tier : '';
}

/** Rejects a model / location / tier combination Vertex does not serve, before any request. */
export function assertVertexServing(route, location, tier) {
  if (tier === VERTEX_FLEX_TIER) {
    if (route.wire !== 'gemini' || !FLEX_MODELS.has(route.id)) {
      throw new Error(`[vertex-ai] Flex PayGo is not available for ${route.id}`);
    }
    if (location !== 'global') throw new Error('[vertex-ai] Flex PayGo is only available with the global location');
  }
  if (tier === VERTEX_PRIORITY_TIER) {
    if (route.wire !== 'gemini' || !PRIORITY_MODELS.has(route.id)) {
      throw new Error(`[vertex-ai] Priority PayGo is not available for ${route.id}`);
    }
    if (!PRIORITY_LOCATIONS.has(location)) {
      throw new Error('[vertex-ai] Priority PayGo is only available with the global, us or eu location');
    }
  }
  const served = route.wire === 'maas' ? LISTED_LOCATIONS.get(`${route.publisher}/${route.id}`) : null;
  if (served && !served.includes(location)) {
    throw new Error(`[vertex-ai] ${route.publisher}/${route.id} is served only in: ${served.join(', ')} (location is ${location})`);
  }
  if (route.wire === 'claude' && VERTEX_MULTI_REGIONS.has(location)) {
    const version = claudeVersion(route.id);
    if (version && (version[0] < 4 || (version[0] === 4 && version[1] < 7))) {
      throw new Error(
        `[vertex-ai] ${route.id} is not served on the ${location} multi-region endpoint (Claude 4.7 and later only); use the global location or a region`
      );
    }
  }
}

// Anthropic's regional premium covers Claude Sonnet 4.5, Haiku 4.5, Opus 4.5
// and later models; an id whose version cannot be read is taken as a later one.
function claudeRegionalPremium(route) {
  if (route.wire !== 'claude') return false;
  const version = claudeVersion(route.id);
  return !version || version[0] > 4 || (version[0] === 4 && version[1] >= 5);
}

/** The pricing SKU of a request, when it differs from the served model id. */
export function vertexPricingModel(route, location) {
  // Open-model rates are the same on every endpoint; their catalog rows are keyed `publisher/model`.
  if (route.wire === 'maas') return `${route.publisher}/${route.id}`;
  if (location === 'global') return undefined;
  if (claudeRegionalPremium(route) || REGIONAL_PREMIUM_GEMINI.has(route.id)) {
    return `${route.id}${VERTEX_REGIONAL_PRICING_SUFFIX}`;
  }
  return undefined;
}

const TIER_OPTIONS = Object.freeze({
  [VERTEX_FLEX_TIER]: Object.freeze({ value: VERTEX_FLEX_TIER, label: 'Flex (50% off, slower)' }),
  [VERTEX_PRIORITY_TIER]: Object.freeze({ value: VERTEX_PRIORITY_TIER, label: 'Priority (faster, higher price)' }),
});

/** The service-tier parameter a listed model offers, or null. */
export function vertexTierOption(id) {
  const tiers = [
    ...(FLEX_MODELS.has(id) ? [TIER_OPTIONS[VERTEX_FLEX_TIER]] : []),
    ...(PRIORITY_MODELS.has(id) ? [TIER_OPTIONS[VERTEX_PRIORITY_TIER]] : []),
  ];
  if (!tiers.length) return null;
  return {
    id: VERTEX_SERVICE_TIER_PARAMETER,
    label: 'Service tier',
    kind: 'enum',
    options: [{ value: 'standard', label: 'Standard' }, ...tiers],
  };
}

const MODEL_GARDEN = 'https://console.cloud.google.com/agent-platform/publishers';

/**
 * A 404, or a 403 that names the model's enablement, means the model is not
 * enabled for the project (or the id is wrong): the error says so and where to
 * enable it. Status and the other classification fields stay as they were.
 */
export function vertexModelAccessError(error, route, { project, location }) {
  if (!error || typeof error !== 'object') return error;
  const status = [error.status, error.httpStatus, error.response?.status]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  const detail = String(error.message || '');
  let body = '';
  try {
    body = error.error && typeof error.error === 'object' ? JSON.stringify(error.error) : '';
  } catch {}
  const text = `${detail} ${body}`;
  // An IAM decision (the caller lacks a permission such as
  // aiplatform.endpoints.predict) stays as it is, whatever resource it names.
  const iamDenied = /Permission '[^']+' denied|IAM_PERMISSION_DENIED/i.test(text);
  const notEnabled =
    !iamDenied &&
    // NOT_FOUND: "Publisher Model `…` was not found or your project does not have access to it".
    (status === 404 ||
      // FAILED_PRECONDITION: "Project `…` is not allowed to use Publisher Model `…`".
      (status === 400 && /is not allowed to use Publisher Model/i.test(text)) ||
      // Partner-model enablement: the model, or its terms, not enabled for the project.
      (status === 403 &&
        /is not allowed to use Publisher Model|(?:has not been|is not|not yet) enabled|enable (?:it|the model|this model) in Model Garden|accept the terms of service/i.test(
          text
        )));
  if (!notEnabled || error.code === 'VERTEX_MODEL_NOT_ENABLED') return error;
  error.message =
    `[vertex-ai] ${route.publisher}/${route.id} was not found or is not enabled for project ${project} in ${location}. ` +
    `Check the model id and enable the model in Model Garden: ${MODEL_GARDEN}/${route.publisher}/model-garden/${route.id} ` +
    `(HTTP ${status}: ${detail.slice(0, 200)})`;
  error.code = 'VERTEX_MODEL_NOT_ENABLED';
  return error;
}
