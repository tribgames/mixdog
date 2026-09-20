// Quick (offline) web-search model rows: the "Default" row that follows the
// main model, cached or built-in quick models per capable provider, and the
// configured/current routes, deduplicated per provider:model.
import { clean } from '../session-text.mjs';
import { QUICK_WEB_SEARCH_MODELS } from '../quick-web-search-models.mjs';
import { WEB_SEARCH_DEFAULT_PROVIDER, WEB_SEARCH_DEFAULT_MODEL } from '../workflow.mjs';
import { providerCachedModelsSync } from '../../runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';
import { hydratedModel } from './model-meta.mjs';

export function createQuickWebSearchRows({
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
}) {
  function addQuickWebSearchModel(rows, seen, provider, model) {
    const providerName = normalizeWebSearchProviderId(provider);
    const modelId = clean(model?.id || model);
    if (!providerName || !modelId || !isWebSearchCapableProvider(providerName)) return;
    const key = `${providerName}:${modelId}`;
    if (seen.has(key)) return;
    const resolved = hydratedModel(providerName, model);
    const row = providerModelCacheRow(providerName, {
      id: modelId,
      name: resolved?.name || resolved?.display || modelId,
      display: resolved?.display || resolved?.name || modelId,
      contextWindow: resolved?.contextWindow || null,
      outputTokens: resolved?.outputTokens || null,
      latest: resolved?.latest === true,
      supportsWebSearch: true,
      supportsFunctionCalling: resolved?.supportsFunctionCalling === true,
      supportsPromptCaching: resolved?.supportsPromptCaching === true,
      supportsReasoning: resolved?.supportsReasoning === true,
      reasoningLevels: Array.isArray(resolved?.reasoningLevels) ? resolved.reasoningLevels : undefined,
      reasoningOptions: Array.isArray(resolved?.reasoningOptions) ? resolved.reasoningOptions : [],
      reasoningContentField: resolved?.reasoningContentField || null,
      mode: 'chat',
    });
    if (row.supportsWebSearch !== true) return;
    seen.add(key);
    rows.push({
      ...row,
      provider: providerName,
      webSearchCapable: true,
      webSearchToolType: row.webSearchToolType || 'web_search',
    });
  }

  function addDefaultWebSearchModel(rows, seen = new Set()) {
    const route = getRoute();
    const mainModel = currentMainWebSearchModelMeta();
    if (!mainModel || !webSearchCapableFor(route.provider, mainModel)) return;
    const key = `${WEB_SEARCH_DEFAULT_PROVIDER}:${WEB_SEARCH_DEFAULT_MODEL}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: WEB_SEARCH_DEFAULT_MODEL,
      provider: WEB_SEARCH_DEFAULT_PROVIDER,
      display: 'Default',
      name: 'Default',
      description: `Use current main model: ${route.provider}/${route.model}`,
      supportsWebSearch: true,
      webSearchCapable: true,
      webSearchToolType: 'web_search',
      mode: 'chat',
    });
  }

  function webSearchModelsFromRows(rows) {
    return sortProviderModels(
      (rows || [])
        .filter((row) => row.supportsWebSearch === true)
        .map((row) => ({
          ...row,
          provider: normalizeWebSearchProviderId(row.provider),
          webSearchCapable: true,
          webSearchToolType: row.webSearchToolType || 'web_search',
        }))
    );
  }

  function quickWebSearchProviderModelRows() {
    const route = getRoute();
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    addDefaultWebSearchModel(rows, seen);
    for (const [name, providerConfig] of Object.entries(pickerConfig.providers || {})) {
      const providerName = normalizeWebSearchProviderId(name);
      if (!providerConfig?.enabled || !isWebSearchCapableProvider(providerName)) continue;
      const cachedModels = providerCachedModelsSync(providerName);
      const quickModels = cachedModels.length ? cachedModels : QUICK_WEB_SEARCH_MODELS[providerName] || [];
      for (const model of quickModels) {
        addQuickWebSearchModel(rows, seen, providerName, model);
      }
    }
    const configuredWebSearch =
      normalizeWebSearchRouteConfig(pickerConfig.webSearchRoute) || normalizeWebSearchRouteConfig(getWebSearchRoute());
    if (configuredWebSearch?.provider && configuredWebSearch?.model) {
      addQuickWebSearchModel(rows, seen, configuredWebSearch.provider, {
        id: configuredWebSearch.model,
        display: configuredWebSearch.model,
      });
    }
    const mainModel = currentMainWebSearchModelMeta();
    if (mainModel && webSearchCapableFor(route.provider, mainModel)) {
      addQuickWebSearchModel(rows, seen, route.provider, {
        id: route.model,
        display: route.model,
      });
    }
    return webSearchModelsFromRows(rows);
  }

  function webSearchRowsWithDefault(rows = []) {
    const out = [];
    const seen = new Set();
    addDefaultWebSearchModel(out, seen);
    for (const row of rows || []) {
      const providerName = normalizeWebSearchProviderId(row?.provider);
      const modelId = clean(row?.id || row?.model);
      if (providerName === WEB_SEARCH_DEFAULT_PROVIDER && modelId.toLowerCase() === WEB_SEARCH_DEFAULT_MODEL) continue;
      const key = `${providerName}:${modelId}`;
      if (!providerName || !modelId || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  return {
    addQuickWebSearchModel,
    addDefaultWebSearchModel,
    quickWebSearchProviderModelRows,
    webSearchModelsFromRows,
    webSearchRowsWithDefault,
  };
}
