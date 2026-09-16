/**
 * openai-oauth-catalog.mjs — Codex model catalog for the openai-oauth provider.
 *
 * Extracted from openai-oauth.mjs: the /backend-api/codex/models query, its
 * 24h disk cache plus in-memory mirror, and the lookups the request path needs
 * (service tiers, "newest main model", "does the live model exist"). The
 * endpoint returns richer metadata than /v1/models (context_window, reasoning
 * levels, visibility), so the catalog is normalized and enriched once here and
 * every consumer reads the same records.
 *
 * openai-oauth.mjs re-exports the lookups it used to own so existing importers
 * resolve unchanged.
 */
import { makeModelCache } from './model-cache.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { modelSupportsServiceTier } from './model-service-tiers.mjs';
import { warmCodexClientVersion } from './codex-client-meta.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { CODEX_OAUTH_ORIGINATOR, codexModelsUrl } from './openai-codex-endpoints.mjs';
import { _normalizeCodexModel, _markLatestCodex, _compareVersion, _isMainCodexFamily } from './openai-codex-model.mjs';

const CODEX_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const CODEX_MODEL_CACHE_SCHEMA_VERSION = 3;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

// In-memory mirror of the on-disk catalog, same pattern as anthropic-oauth.
// Populated on first catalog read and after every save.
let _mirror = null;
let _refreshInFlight = null;

const _modelCache = makeModelCache({
  fileName: 'openai-oauth-models.json',
  ttlMs: CODEX_MODEL_CACHE_TTL_MS,
  version: CODEX_MODEL_CACHE_SCHEMA_VERSION,
  onSave: (models) => {
    _mirror = Array.isArray(models) ? models.slice() : null;
  },
});

/** Fresh on-disk catalog (null past the TTL), adopted as the mirror. */
export function loadCodexCatalogCache() {
  const cached = _modelCache.loadSync();
  if (cached) _mirror = cached.slice();
  return cached;
}

export function findCachedCodexModel(id) {
  if (!id) return null;
  if (!Array.isArray(_mirror)) {
    _mirror = _modelCache.loadSync();
  }
  if (!Array.isArray(_mirror)) return null;
  return _mirror.find((m) => m?.id === id) || null;
}

export function codexCatalogHas(id) {
  if (!id || !Array.isArray(_mirror)) return false;
  return _mirror.some((m) => m.id === id);
}

export function codexModelSupportsServiceTier(id, serviceTier) {
  return modelSupportsServiceTier(findCachedCodexModel(id), serviceTier);
}

// Newest MAIN gpt-5 chat model by version, read from the SYNC in-memory
// catalog mirror. Returns null until populated; callers warm via
// ensureLatestCodexModel when null.
export function resolveLatestCodexModel() {
  if (!Array.isArray(_mirror)) return null;
  let best = null;
  for (const m of _mirror) {
    if (!m?.id || !_isMainCodexFamily(m.family)) continue;
    if (!best || _compareVersion(m.id, best.id) > 0) best = m;
  }
  return best?.id || null;
}

export async function ensureLatestCodexModel(refreshCatalog) {
  let m = resolveLatestCodexModel();
  if (m) return m;
  await refreshCatalog();
  m = resolveLatestCodexModel();
  if (m) return m;
  throw new Error('[openai-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

/**
 * One catalog round-trip: query, normalize, enrich, persist. Throws on any
 * transport/HTTP failure so each caller can apply its own recovery; `label`
 * keeps each caller's historical failure text intact in the logs.
 */
async function fetchCodexCatalog(ensureAuth, label) {
  const auth = await ensureAuth();
  const clientVersion = await warmCodexClientVersion();
  const res = await fetch(codexModelsUrl(clientVersion), {
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      'OpenAI-Beta': 'responses=experimental',
      originator: CODEX_OAUTH_ORIGINATOR,
      'chatgpt-account-id': auth.account_id || '',
    },
    dispatcher: getLlmDispatcher(),
  });
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data?.models) ? data.models : [];
  const normalized = items.map((m) => _normalizeCodexModel(m));
  _markLatestCodex(normalized);
  const enriched = sanitizeModelList((await enrichModels(normalized)).filter(Boolean), { provider: 'openai-oauth' });
  _modelCache.save(enriched);
  return enriched;
}

/** Catalog for the picker: cached 24h, refetched on miss. */
export async function listCodexModels(ensureAuth) {
  const cached = loadCodexCatalogCache();
  if (cached) return cached;
  try {
    return await fetchCodexCatalog(ensureAuth, 'openai-oauth list_models');
  } catch (err) {
    process.stderr.write(`[openai-oauth] listModels fetch failed (${err?.message || String(err)})\n`);
    // No fallback catalog — empty list signals the UI to show a
    // "catalog unavailable, retry" state. openai-oauth has no equivalent to
    // Anthropic's family tokens so there's no meaningful minimal list.
    return [];
  }
}

/**
 * Force a catalog refresh (ignores the 24h TTL). De-duped so concurrent
 * callers share one HTTP round-trip; null on failure.
 */
export async function refreshCodexCatalog(ensureAuth) {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      const enriched = await fetchCodexCatalog(ensureAuth, 'codex list_models');
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[openai-oauth] catalog refreshed (${enriched.length} models)\n`);
      return enriched;
    } catch (err) {
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[openai-oauth] catalog refresh failed (${err.message})\n`);
      return null;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}
