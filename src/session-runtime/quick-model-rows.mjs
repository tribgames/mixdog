// Quick (offline) provider/model picker row builders.
// Dependency-injected factory: closes over route/config/web-search accessors
// and shared row helpers supplied by the facade. Main-model rows and
// web-search rows are built in quick-model-rows/*.mjs.
import { createQuickProviderRows } from './quick-model-rows/provider-rows.mjs';
import { createQuickWebSearchRows } from './quick-model-rows/web-search-rows.mjs';

export function createQuickModelRows({
  getRoute,
  getWebSearchRoute,
  displayConfig,
  providerModelCacheRow,
  providerModelsFromCacheRows,
  sortProviderModels,
  modelMetaByRoute,
  modelMetaKey,
  normalizeWebSearchProviderId,
  normalizeWebSearchRouteConfig,
  isWebSearchCapableProvider,
  webSearchCapableFor,
  currentMainWebSearchModelMeta,
}) {
  const quickProviderModelRows = createQuickProviderRows({
    getRoute,
    displayConfig,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    modelMetaByRoute,
    modelMetaKey,
  });
  const webSearch = createQuickWebSearchRows({
    getRoute,
    getWebSearchRoute,
    displayConfig,
    providerModelCacheRow,
    sortProviderModels,
    normalizeWebSearchProviderId,
    normalizeWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor,
    currentMainWebSearchModelMeta,
  });
  return { quickProviderModelRows, ...webSearch };
}
