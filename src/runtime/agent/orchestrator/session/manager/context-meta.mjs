// Context-window sizing, compaction target math, and session context-meta
// resolution.

import { getModelMetadataSync } from '../../providers/model-catalog.mjs';
import { contextWindowRange } from '../../../../shared/llm/default-context-window.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';

// Family-pattern fallback used only when the provider and external catalogs
// both miss (cold metadata, before the LiteLLM/models.dev catalog warms). Keep these aligned with the catalog so /context, gateway, and the
// runtime agree on the boundary the first time a model is routed. Local models
// (llama/mistral/phi/qwen/gemma) stay small so an unknown local id never claims
// a giant window.
const LOCAL_PROVIDERS = new Set(['mixdog-local', 'local', '']);
function guessContextWindow(model, provider = null) {
  const m = String(model || '').toLowerCase();
  const p = String(provider || '').toLowerCase();
  const isLocalProvider = LOCAL_PROVIDERS.has(p);
  // Cursor's backend defaults to the standard 200k tier when its live
  // catalog has not warmed yet. Larger Max windows are model metadata, not
  // a safe cold-start request boundary.
  if ((p === 'cursor-oauth' || p === 'cursor-api') && m) return 200000;
  // Local/self-hosted families — never inflate an unknown local id.
  if (
    isLocalProvider &&
    (m.includes('llama') ||
      m.includes('mistral') ||
      m.includes('mixtral') ||
      m.includes('phi') ||
      m.includes('qwen') ||
      m.includes('gemma') ||
      m.includes('deepseek-r1') ||
      m.includes('codellama'))
  )
    return 8192;
  // Current hosted families by name pattern.
  if (/^claude-(opus|sonnet|fable)/.test(m)) return 1000000;
  if (m.startsWith('claude-')) return 200000;
  if (m.startsWith('gemini-3') || m.startsWith('gemini-2')) return 1000000;
  if (/^gpt-[56]/.test(m)) return 272000;
  if (m.startsWith('grok-build')) return 256000;
  // Grok 4.5+ serve 500k; older 1M SKUs only lose headroom on a cold catalog.
  if (m.startsWith('grok-')) return 500000;
  if (m.startsWith('deepseek-v')) return 1000000;
  return 128000;
}
function boundedPercent(value, fallback = null) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  return fallback;
}
function providerNameOf(provider) {
  if (typeof provider === 'string') return provider.toLowerCase();
  return String(provider?.name || provider?.id || '').toLowerCase();
}
// Carry the percent/ratio-named buffer config from a compaction config object
// onto session.compaction so the shared compact-policy parser honors configured
// buffer
// percent/ratio. Only finite positive values are copied; absent fields stay
// undefined so the default-ratio fallback still applies.
export function preserveBufferConfigFields(cfg = {}) {
  const out = {};
  for (const key of [
    'bufferPercent',
    'bufferPct',
    'bufferRatio',
    'bufferFraction',
    'mainBufferPercent',
    'mainBufferPct',
    'mainBufferRatio',
    'mainBufferFraction',
  ]) {
    const n = Number(cfg?.[key]);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}
// The session boundary is the model's full raw window. Headroom is applied
// by resolveSessionCompactPolicy instead: agent sessions compact at the
// buffered trigger, while main/user sessions compact on the boundary.
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 100;
function providerRawContextWindow(info, catalogInfo) {
  if (!info || typeof info !== 'object') return null;
  const fromApiFields = positiveInt(info.context_window) || positiveInt(info.max_context_window);
  if (fromApiFields) return fromApiFields;
  const fromCache = positiveInt(info.contextWindow) || positiveInt(info.maxContextWindow);
  const catalogWindow =
    positiveInt(catalogInfo?.contextWindow) ||
    positiveInt(catalogInfo?.maxContextWindow) ||
    positiveInt(catalogInfo?.context_window) ||
    positiveInt(catalogInfo?.max_context_window);
  // Catalog/known metadata is authoritative for models present in the
  // catalog. A stale provider cache can hold an outdated window (e.g. Opus
  // 4.8 cached at 272k after its window grew to the catalog's 1M, or a
  // synthetic 1M placeholder for a smaller real model); whenever the catalog
  // disagrees with the cached snapshot, trust the catalog value rather than
  // the cache. Only live API fields (handled above) outrank the catalog.
  if (catalogWindow && fromCache !== catalogWindow) return catalogWindow;
  return fromCache || null;
}
// `wholeWindow` asks for everything the model can take in (the summary route
// budgets its own input that way) instead of the window a session starts with.
export function resolveSessionContextMeta(provider, model, seed = {}, { wholeWindow = false } = {}) {
  const info = typeof provider?.getCachedModelInfo === 'function' ? provider.getCachedModelInfo(model) : null;
  const catalogInfo = getModelMetadataSync(model, providerNameOf(provider));
  const servedContextWindow =
    providerRawContextWindow(info, catalogInfo) ||
    positiveInt(catalogInfo?.contextWindow) ||
    positiveInt(catalogInfo?.maxContextWindow) ||
    positiveInt(catalogInfo?.context_window) ||
    positiveInt(catalogInfo?.max_context_window) ||
    positiveInt(seed.rawContextWindow) ||
    positiveInt(seed.raw_context_window) ||
    positiveInt(seed.contextWindow) ||
    guessContextWindow(model, providerNameOf(provider));
  // A session that records no selection starts from the model's default
  // window, the one the picker shows. A recorded percentage without its window
  // (a session older than selectedContextWindow, a route saved before the
  // catalog warmed) is still the user's choice and keeps the served window.
  const recordsSelection = wholeWindow || boundedPercent(seed.contextPercent) !== null;
  const requestedContextWindow =
    positiveInt(seed.selectedContextWindow) ||
    (recordsSelection
      ? servedContextWindow
      : contextWindowRange({ provider: providerNameOf(provider), contextWindow: servedContextWindow }).defaultWindow);
  // A managed runtime's allocated capacity also bounds restored selections
  // and catalog metadata; raising a slider cannot allocate server memory.
  const runtimeContextWindow = positiveInt(info?.runtimeContextWindow);
  const rawContextWindow = runtimeContextWindow
    ? Math.min(requestedContextWindow, runtimeContextWindow)
    : requestedContextWindow;
  const effectiveContextWindowPercent = boundedPercent(
    seed.effectiveContextWindowPercent ??
      seed.effective_context_window_percent ??
      info?.effectiveContextWindowPercent ??
      info?.effective_context_window_percent ??
      catalogInfo?.effectiveContextWindowPercent ??
      catalogInfo?.effective_context_window_percent,
    DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT
  );
  const contextWindow = Math.max(1, Math.floor((rawContextWindow * effectiveContextWindowPercent) / 100));
  const compactBoundaryTokens = contextWindow;
  const rawCompactLimit = positiveInt(
    seed.autoCompactTokenLimit ??
      seed.auto_compact_token_limit ??
      info?.autoCompactTokenLimit ??
      info?.auto_compact_token_limit ??
      catalogInfo?.autoCompactTokenLimit ??
      catalogInfo?.auto_compact_token_limit
  );
  // Legacy-data migration: old implementations derived autoCompactTokenLimit
  // from the full effective/raw window and persisted it onto the session.
  // A resumed session therefore re-seeds autoCompactTokenLimit == boundary
  // (or the raw window), which compactTriggerForSession / loop policy used to
  // honor as an explicit trigger, collapsing the compaction buffer to 0. Only
  // accept an explicit limit that is STRICTLY BELOW the boundary; a value at
  // or above the boundary is a derived full-window artifact and is dropped to
  // null so the trigger falls back to the default boundary trigger.
  const explicitCompactLimit = rawCompactLimit && rawCompactLimit < compactBoundaryTokens ? rawCompactLimit : null;
  // Do NOT derive the auto-compact limit from the full effective window.
  // Setting it to contextWindow makes the trigger equal the boundary and the
  // compaction buffer collapse to 0, so auto-compact only fires when the
  // context is already at the limit — at which point Compact fails
  // ("result exceeds budget" / "summary cannot fit") and the turn can no
  // longer be resumed. Leave it null unless the provider/catalog/seed
  // supplies an explicit limit; the buffer policy in
  // context-compaction-policy.mjs then decides the trigger.
  return {
    contextWindow,
    rawContextWindow,
    effectiveContextWindowPercent,
    autoCompactTokenLimit: explicitCompactLimit || null,
    compactBoundaryTokens,
  };
}
