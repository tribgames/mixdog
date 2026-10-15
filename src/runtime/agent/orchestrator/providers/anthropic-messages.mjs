// Anthropic model catalog + message conversion helpers.
import { createRequire } from 'node:module';
import { effortValuesForModel, thinkingTypesFromCapabilities } from './anthropic-effort.mjs';
import { makeModelCache } from './model-cache.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import {
  deferredAnthropicTools as sharedDeferredAnthropicTools,
  requestAnthropicTools as sharedRequestAnthropicTools,
  sanitizeAnthropicInputSchema,
  toAnthropicMessages,
} from './lib/anthropic-request-utils.mjs';
import { _capabilitySupported, _defaultContextForModel, _prettyName, modelTier } from './anthropic-model-resolve.mjs';
import { systemBlockItems, systemBlockTtl } from './lib/anthropic-system-blocks.mjs';

// Message lowering lives in the shared request-utils lib (one implementation
// for both Anthropic providers); re-exported here for existing importers.
export { toAnthropicMessages };

const require = createRequire(import.meta.url);
let _Anthropic = null;
export function loadAnthropic() {
  if (!_Anthropic) {
    const mod = require('@anthropic-ai/sdk');
    _Anthropic = mod.default || mod.Anthropic || mod;
  }
  return _Anthropic;
}

// 4-BP cache policy aligned with anthropic-oauth — system + tier3 +
// messages-tail. Tool schemas sit before system and are covered by the system
// breakpoint, so they do not spend a separate cache_control slot. 1h TTL
// requires the extended-cache-ttl beta header, which we set on the client via
// defaultHeaders below.

// BP3 (tier3) rides its own `system` role block (the 3rd system block, tagged
// cacheTier:'tier3'). buildSystemBlocks applies the tier3 1h cache_control to
// that block; BP1/BP2 take the system TTL. Mirrors anthropic-oauth.mjs.

export function buildSystemBlocks(systemMsgs, systemTtl, tier3Ttl) {
  // systemMsgs is an array of { content, cacheTier }. Each non-empty element
  // becomes its own content block: cacheTier:'tier3' (BP3 core) gets
  // tier3Ttl, cacheTier:'env' (volatile session/project environment) is
  // NEVER marked — it rides the messages-tail breakpoint so an environment
  // change cannot invalidate the BP3 core write — and every other block
  // (BP1/BP2) gets systemTtl. A null TTL leaves the block uncached.
  const items = systemBlockItems(systemMsgs);
  // Anthropic caps cache_control breakpoints at 4 per request; defensively
  // cap it here too so an unexpectedly large systemMsgs array can never
  // mark more than 4 blocks (extras keep their text, just lose the
  // cache_control breakpoint, not the block itself). Mirrors
  // anthropic-oauth.mjs.
  const MAX_SYSTEM_BREAKPOINTS = 4;
  let bpCount = 0;
  return items.map((it, index) => {
    // Anthropic joins system text blocks with no separator; open every
    // block after the first with a paragraph break so headings never glue
    // onto the previous block's last line. Mirrors anthropic-oauth.mjs.
    const block = { type: 'text', text: index ? `\n\n${it.text}` : it.text };
    const ttl = systemBlockTtl(it.tier, { tier3Ttl, systemTtl });
    if (ttl && bpCount < MAX_SYSTEM_BREAKPOINTS) {
      block.cache_control = ttl;
      bpCount++;
    }
    return block;
  });
}

export function _normalizeAnthropicModel(raw, provider = 'anthropic') {
  const id = raw?.id || raw?.name || raw?.model;
  if (!id) return null;
  const familyMatch = String(id).match(/^claude-([a-z]+)/i);
  const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
  const dated = /-\d{8}$/.test(String(id));
  const versioned = !dated && /^claude-[a-z]+-\d+(?:-\d+)?$/i.test(String(id));
  const effortValues = effortValuesForModel(raw?.capabilities, id);
  const thinkingTypes = thinkingTypesFromCapabilities(raw?.capabilities);
  return {
    id,
    display: raw?.display_name || raw?.displayName || raw?.display || _prettyName(id, family),
    family,
    provider,
    contextWindow:
      raw?.context_window ||
      raw?.max_context_window ||
      raw?.max_input_tokens ||
      raw?.input_token_limit ||
      raw?.inputTokenLimit ||
      _defaultContextForModel(id),
    outputTokens: raw?.max_tokens || raw?.max_output_tokens || raw?.output_token_limit || raw?.outputTokenLimit || null,
    tier: modelTier(dated, versioned),
    latest: false,
    supportsReasoning: effortValues.length > 0 || _capabilitySupported(raw?.capabilities?.thinking),
    reasoningOptions: effortValues.length ? [{ type: 'effort', values: effortValues }] : [],
    ...(thinkingTypes ? { thinkingTypes } : {}),
  };
}
// The API-key provider has no catalog cache of its own — it reads the same
// anthropic-oauth-models.json disk cache (read-only) that the OAuth provider
// maintains. Both providers hit the same Anthropic /v1/models catalog, so a
// per-model outputTokens entry is valid regardless of which auth path wrote
// it. If this provider is ever run standalone without the OAuth provider
// ever having populated the cache, loadSync() simply returns null and we
// fall through to the shared static heuristic in anthropic-max-tokens.mjs.
const ANTHROPIC_OAUTH_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const _sharedOAuthModelCache = makeModelCache({
  fileName: 'anthropic-oauth-models.json',
  ttlMs: ANTHROPIC_OAUTH_MODEL_CACHE_TTL_MS,
  version: 1,
});

// In-memory mirror populated by this provider's own listModels() fetch.
// API-key-only installs never have the OAuth provider write the shared disk
// cache, so without this mirror catalog outputTokens would stay invisible to
// resolveMaxTokens until an OAuth session runs. listModels() results flow in
// here (memory only — the disk cache stays OAuth-owned/read-only for us).
let _apiKeyCatalogMirror = null;
export function _setApiKeyCatalogMirror(value) {
  _apiKeyCatalogMirror = value;
}

function _catalogOutputTokensFromSharedCache(model) {
  if (!model) return null;
  try {
    const models = Array.isArray(_apiKeyCatalogMirror) ? _apiKeyCatalogMirror : _sharedOAuthModelCache.loadSync();
    if (!Array.isArray(models)) return null;
    const entry = models.find((m) => m?.id === model);
    const out = Number(entry?.outputTokens);
    return Number.isFinite(out) && out > 0 ? out : null;
  } catch {
    return null;
  }
}

export function resolveMaxTokens(model, { modelMaxOutputTokens = null } = {}) {
  return resolveAnthropicMaxTokens(model, { catalogLookup: _catalogOutputTokensFromSharedCache, modelMaxOutputTokens });
}

// Test-only escape hatch for the provider contract scripts
// (scripts/provider-toolcall/_shared.mjs).
export const _test = {
  resolveMaxTokens,
  deferredAnthropicTools,
  requestAnthropicTools,
  sanitizeInputSchema: (schema, toolName) => sanitizeAnthropicInputSchema(schema, toolName, 'anthropic'),
};

function deferredAnthropicTools(activeTools, messages, opts, provider = 'anthropic') {
  return sharedDeferredAnthropicTools(activeTools, messages, opts, provider);
}
// `provider`: the engine's name (a gateway Messages engine runs under its gateway's).
export function requestAnthropicTools(tools, messages, opts, provider = 'anthropic') {
  return sharedRequestAnthropicTools(tools, messages, opts, provider);
}
// Test-only: expose the lowering so the steering-provenance test can assert
// the API-key provider keeps steering-tagged user turns distinct (mirrors
// anthropic-oauth._buildRequestBodyForCacheSmoke coverage).
export function _toAnthropicMessagesForTest(messages, availableTools) {
  return toAnthropicMessages(messages, availableTools);
}
