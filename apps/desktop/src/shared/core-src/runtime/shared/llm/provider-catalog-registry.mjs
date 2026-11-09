// Where each mixdog provider's model metadata comes from. One table read by
// both lookup paths (async list enrichment and the sync lookup), so every
// provider resolves effort ladders, limits, capabilities and pricing in the
// same precedence order (see lookupModelMetadata in model-catalog.mjs).
//
// Fields:
//   modelsDev     models.dev provider id holding this provider's rows.
//   sameEndpoint  true when that models.dev entry describes the endpoint this
//                 provider actually calls; its effort ladders, limits and
//                 capabilities then apply. Otherwise it is only the same
//                 vendor (another endpoint/account plan): it prices the model
//                 and is a first guess for capabilities and the effort ladder
//                 the provider's own sources leave undeclared — never limits.
//   relay         sells other vendors' models; the serving vendor (read off
//                 the model id) is likewise a first guess for capabilities
//                 and the effort ladder, and prices a model with no own rates.
//   rosterFiles   live-roster cache files the provider's listModels persists.
//   rosterLimitsAuthoritative
//                 live-roster limits beat catalog limits (the roster reflects
//                 the account/backend window); otherwise they only fill gaps.
//   rosterLadderFinal
//                 a roster row's effort ladder is complete, empty included:
//                 no guessed ladder is added to a model the roster lists.
//   seedRow       offline seed row for a model id, applied after fetched data.
import { mimoSeedRow, museSeedRow } from './provider-seed-rosters.mjs';

function mimoSeedMetadata(model) {
  const seed = mimoSeedRow(model);
  return seed
    ? {
        contextWindow: seed.contextWindow,
        outputTokens: seed.outputTokens,
        supportsReasoning: seed.reasoning === true,
        supportsVision: seed.vision === true,
      }
    : null;
}

const PROVIDER_CATALOGS = Object.freeze({
  // api.openai.com — the endpoint models.dev `openai` describes.
  openai: { modelsDev: 'openai', sameEndpoint: true },
  // chatgpt.com/backend-api/codex: subscription backend, not the public API.
  'openai-oauth': {
    modelsDev: 'openai',
    sameEndpoint: false,
    rosterFiles: ['openai-oauth-models.json'],
    rosterLimitsAuthoritative: true,
  },
  // api.anthropic.com with a subscription token: account-scoped windows and
  // effort surface differ from the public API SKU.
  'anthropic-oauth': {
    modelsDev: 'anthropic',
    sameEndpoint: false,
    rosterFiles: ['anthropic-oauth-models.json'],
    rosterLimitsAuthoritative: true,
  },
  // api.anthropic.com with an API key. Shares the OAuth roster file.
  anthropic: { modelsDev: 'anthropic', sameEndpoint: true, rosterFiles: ['anthropic-oauth-models.json'] },
  // generativelanguage.googleapis.com — the endpoint models.dev `google` describes.
  gemini: { modelsDev: 'google', sameEndpoint: true, rosterFiles: ['gemini-models.json'] },
  // *aiplatform.googleapis.com: Gemini and Claude publisher models, priced by
  // the LiteLLM `vertex_ai/` rows (model-catalog.mjs prefix table).
  'vertex-ai': { modelsDev: 'google-vertex', sameEndpoint: true },
  // cli-chat-proxy.grok.com, not api.x.ai.
  'grok-oauth': {
    modelsDev: 'xai',
    sameEndpoint: false,
    rosterFiles: ['grok-oauth-models.json'],
    rosterLimitsAuthoritative: true,
  },
  // api.meta.ai/v1 — the endpoint models.dev `meta` describes.
  'muse-code-oauth': {
    modelsDev: 'meta',
    sameEndpoint: true,
    rosterFiles: ['muse-code-oauth-models.json'],
    rosterLimitsAuthoritative: true,
    seedRow: museSeedRow,
  },
  // token-plan-*.xiaomimimo.com subscription gateway, not the public API.
  'mimo-oauth': {
    modelsDev: 'xiaomi',
    sameEndpoint: false,
    rosterFiles: ['mimo-oauth-models.json'],
    rosterLimitsAuthoritative: true,
    seedRow: mimoSeedMetadata,
  },
  // Relays: their own models.dev id (when published) is their own endpoint.
  // Effort tiers live in the wire id; a row without levels has no effort
  // surface (resolveAntigravityWireModel drops the effort).
  'antigravity-oauth': { relay: true, rosterFiles: ['antigravity-oauth-models.json'], rosterLadderFinal: true },
  // api.commandcode.ai/provider/v1 relays other vendors' models.
  'command-code-oauth': {
    relay: true,
    rosterFiles: ['command-code-oauth-models.json'],
    rosterLimitsAuthoritative: true,
  },
  'cursor-oauth': { relay: true },
  'devin-oauth': { relay: true },
  'cursor-api': { relay: true },
  // The models.dev listing id of the Go gateway: a relay catalog, not a
  // selectable provider (the model lookup needs it flagged as a relay).
  'opencode-go': { relay: true },
  // The Go gateway through an OpenCode Console login; the organization
  // config's catalog is the live roster.
  'opencode-go-oauth': {
    modelsDev: 'opencode-go',
    relay: true,
    rosterFiles: ['opencode-go-oauth-models.json'],
    rosterLimitsAuthoritative: true,
  },
});

// Confirmed upstream catalog gaps, keyed provider → model. Each entry patches
// the mapped models.dev row; a live roster that declares the field still wins.
const VERIFIED_CORRECTIONS = Object.freeze({
  'muse-code-oauth': Object.freeze({
    // models.dev `meta` stops this ladder at xhigh; the Muse OAuth endpoint
    // accepts reasoning.effort "max" for the contributor tier as for 1.3.
    'muse-spark-1.3-contributor': Object.freeze({
      reasoningOptions: Object.freeze([
        Object.freeze({ type: 'effort', values: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) }),
      ]),
    }),
  }),
});

const key = (provider) =>
  String(provider || '')
    .trim()
    .toLowerCase();

/** Registry entry with defaults; an unlisted provider is its own models.dev id and endpoint. */
export function providerCatalogEntry(provider) {
  const p = key(provider);
  if (!p) return null;
  const entry = PROVIDER_CATALOGS[p] || {};
  return {
    provider: p,
    modelsDev: entry.modelsDev || p,
    sameEndpoint: entry.sameEndpoint !== false,
    relay: entry.relay === true,
    rosterFiles: entry.rosterFiles || [],
    rosterLimitsAuthoritative: entry.rosterLimitsAuthoritative === true,
    rosterLadderFinal: entry.rosterLadderFinal === true,
    seedRow: entry.seedRow || null,
  };
}

/** models.dev ids of the registered non-relay providers: vendors that serve their own models. */
export function firstPartyModelsDevIds() {
  return [
    ...new Set(
      Object.values(PROVIDER_CATALOGS)
        .filter((entry) => entry.relay !== true && entry.modelsDev)
        .map((entry) => entry.modelsDev)
    ),
  ].sort();
}

export function modelsDevProviderId(provider) {
  return providerCatalogEntry(provider)?.modelsDev || null;
}

export function providerRosterFiles(provider) {
  return providerCatalogEntry(provider)?.rosterFiles || [];
}

/** Providers owning a live-roster file; a provider reading another's file is skipped. */
export function rosterProviders() {
  const seen = new Set();
  const out = [];
  for (const [provider, entry] of Object.entries(PROVIDER_CATALOGS)) {
    const files = entry.rosterFiles || [];
    if (!files.length || files.every((file) => seen.has(file))) continue;
    for (const file of files) seen.add(file);
    out.push(provider);
  }
  return out;
}

export function providerSeedRow(provider, model) {
  return providerCatalogEntry(provider)?.seedRow?.(String(model || '')) || null;
}

export function providerMetadataCorrection(provider, model) {
  return VERIFIED_CORRECTIONS[key(provider)]?.[String(model || '')] || null;
}
