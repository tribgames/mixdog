// Offline quick-pick model rows for onboarding / web-search setup. No model id
// is listed here: when a provider has no live roster yet, its newest rows come
// from the provider-scoped public catalog, so a new release appears without a
// code change. Rows are hydrated further during catalog construction.
import { getModelsDevProviderModelsSync } from '../runtime/shared/llm/model-catalog.mjs';

export const ONBOARDING_VERSION = 1;

const QUICK_ROWS_PER_PROVIDER = 5;

export function quickWebSearchModels(provider, models = getModelsDevProviderModelsSync(provider)) {
  return Object.entries(models || {})
    .map(([id, row]) => ({ id, display: row?.name || id, releaseDate: row?.release_date || null }))
    .sort((a, b) => (Date.parse(b.releaseDate) || 0) - (Date.parse(a.releaseDate) || 0))
    .slice(0, QUICK_ROWS_PER_PROVIDER);
}
