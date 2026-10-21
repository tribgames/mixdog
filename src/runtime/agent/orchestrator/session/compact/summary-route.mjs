// What the compaction summary route choice reads: whether the session's
// prompt cache is still warm (a fork of its last request would read it), and
// the lighter model of a subscription provider.
import { cacheCapabilityForProvider, providerTailCacheLifetimeMs } from '../../agent-runtime/cache-strategy.mjs';
import { getModelMetadataSync } from '../../../../shared/llm/model-catalog.mjs';
import {
  _compareVersion as compareAnthropicVersion,
  _loadModelCache as loadAnthropicCatalogCache,
} from '../../providers/anthropic-model-resolve.mjs';
import { gptVersion } from '../../providers/openai-model-capabilities.mjs';
import { loadSavedCodexCatalog } from '../../providers/openai-oauth-catalog-store.mjs';
import { compactionForkRequest } from '../side-question-store.mjs';

// A provider outside the Anthropic/OpenAI lifetimes whose catalog marks prompt
// caching: the shortest common cache lifetime (Gemini's default TTL).
const CATALOG_PROMPT_CACHE_LIFETIME_MS = 5 * 60_000;
// The cache is read when the fork is sent, after the route choice: a request
// this close to its lifetime counts as cold.
const WARM_MARGIN_MIN_MS = 30_000;
const WARM_MARGIN_RATIO = 0.1;

/** How long the cache a saved request wrote or read stays readable, in ms:
 *  Infinity when it does not expire (openai-oauth), 0 when it is not cached.
 *  Anthropic: the request's message-tail tier (5m / 1h); OpenAI: the 30m tail
 *  that holds the conversation (the Lead's 12h breakpoint covers only the
 *  stable tools/instructions prefix). */
function requestCacheLifetimeMs(request) {
  const name = request?.provider?.name;
  if (name === 'openai-oauth') return Infinity;
  if (name === 'openai' || cacheCapabilityForProvider(name) === 'explicit-breakpoint') {
    return providerTailCacheLifetimeMs(name, request.opts?.cacheStrategy) ?? 0;
  }
  const info = request.provider.getCachedModelInfo?.(request.model) || getModelMetadataSync(request.model, name);
  return info?.supportsPromptCaching ? CATALOG_PROMPT_CACHE_LIFETIME_MS : 0;
}

/** Whether the session's last settled request is still inside the cache
 *  lifetime it used, with a safety margin. No forkable request = cold. */
export function compactionCacheWarm(sessionId, now = Date.now()) {
  const request = compactionForkRequest(sessionId);
  if (!request) return false;
  const lifetime = requestCacheLifetimeMs(request);
  if (lifetime === Infinity) return true;
  const margin = Math.max(WARM_MARGIN_MIN_MS, lifetime * WARM_MARGIN_RATIO);
  return now - Number(request.sentAt) < lifetime - margin;
}

function compareGptVersion(a, b) {
  const [aMajor, aMinor] = gptVersion(a);
  const [bMajor, bMinor] = gptVersion(b);
  // Same version: the undated alias over a dated snapshot.
  return aMajor - bMajor || aMinor - bMinor || b.length - a.length;
}

// The lighter family per subscription provider: its newest catalog model.
// API-key providers bill per token and get no lighter step. `catalog` reads
// the provider's saved catalog only (disk cache, no auth or network on the
// compaction path): Anthropic's within its 24h TTL, Codex's stale or not.
const LIGHTER_FAMILY = Object.freeze({
  'anthropic-oauth': {
    catalog: loadAnthropicCatalogCache,
    matches: (row) => row.family === 'haiku',
    compare: compareAnthropicVersion,
  },
  'openai-oauth': {
    catalog: loadSavedCodexCatalog,
    matches: (row, id) => id.includes('-luna') && gptVersion(id) !== null,
    compare: compareGptVersion,
  },
});

/** The newest lighter-family model the saved catalog of `providerName` lists
 *  for this account, or null (not a subscription provider, no saved catalog,
 *  none listed). */
export async function lighterSubscriptionModel(providerName) {
  const family = LIGHTER_FAMILY[providerName];
  if (!family) return null;
  const catalog = await family.catalog();
  if (!Array.isArray(catalog)) return null;
  let best = null;
  for (const row of catalog) {
    const id = String(row?.id || '');
    if (!id || !family.matches(row, id)) continue;
    if (!best || family.compare(id, best) > 0) best = id;
  }
  return best;
}
