// Quick (offline) provider/model picker row builders, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory: closes over
// route/config/search accessors and shared row helpers supplied by the facade.
import { clean } from './session-text.mjs';
import { QUICK_SEARCH_MODELS } from './quick-search-models.mjs';
import { SEARCH_DEFAULT_PROVIDER, SEARCH_DEFAULT_MODEL } from './workflow.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';

function metadataFor(provider, modelId) {
  try {
    return getModelMetadataSync(modelId, provider) || {};
  } catch {
    return {};
  }
}

function hydratedModel(provider, model = {}) {
  const modelId = clean(model?.id || model);
  const meta = metadataFor(provider, modelId);
  const base = model && typeof model === 'object' ? model : { id: modelId };
  return {
    ...base,
    contextWindow: meta.contextWindow || base?.contextWindow || null,
    outputTokens: meta.outputTokens || base?.outputTokens || null,
    supportsWebSearch: base?.supportsWebSearch === true || meta.supportsWebSearch === true,
    supportsFunctionCalling: base?.supportsFunctionCalling === true || meta.supportsFunctionCalling === true,
    supportsPromptCaching: base?.supportsPromptCaching === true || meta.supportsPromptCaching === true,
    supportsReasoning: base?.supportsReasoning === true || meta.supportsReasoning === true,
    reasoningOptions: Array.isArray(base?.reasoningOptions) && base.reasoningOptions.length ? base.reasoningOptions : (meta.reasoningOptions || []),
    reasoningContentField: base?.reasoningContentField || meta.reasoningContentField || null,
  };
}

export function createQuickModelRows({
  getRoute,
  getSearchRoute,
  displayConfig,
  providerModelCacheRow,
  providerModelsFromCacheRows,
  sortProviderModels,
  modelMetaByRoute,
  modelMetaKey,
  normalizeSearchProviderId,
  normalizeSearchRouteConfig,
  isSearchCapableProvider,
  searchCapableFor,
  currentMainSearchModelMeta,
}) {
  function quickProviderModelRows() {
    const route = getRoute();
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    const addRoute = (routeLike = {}) => {
      const provider = clean(routeLike.provider);
      const model = clean(routeLike.model);
      if (!provider || !model) return;
      const key = `${provider}:${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      const meta = metadataFor(provider, model);
      const row = providerModelCacheRow(provider, {
        id: model,
        name: routeLike.modelDisplay || routeLike.display || model,
        display: routeLike.modelDisplay || routeLike.display || model,
        contextWindow: meta.contextWindow || null,
        outputTokens: meta.outputTokens || null,
        latest: routeLike.latest === true,
        supportsReasoning: !!routeLike.effort || meta.supportsReasoning === true,
        supportsFunctionCalling: meta.supportsFunctionCalling === true,
        supportsPromptCaching: meta.supportsPromptCaching === true,
        reasoningOptions: meta.reasoningOptions || [],
        reasoningContentField: meta.reasoningContentField || null,
        mode: 'chat',
      });
      rows.push(row);
      modelMetaByRoute.set(modelMetaKey(provider, model), row);
    };

    addRoute(route);
    for (const preset of pickerConfig.presets || []) addRoute(preset);
    for (const workflowRoute of Object.values(pickerConfig.workflowRoutes || {})) addRoute(workflowRoute);
    for (const agentRoute of Object.values(pickerConfig.agents || {})) addRoute(agentRoute);
    return providerModelsFromCacheRows(rows);
  }

  function addQuickSearchModel(rows, seen, provider, model) {
    const providerName = normalizeSearchProviderId(provider);
    const modelId = clean(model?.id || model);
    if (!providerName || !modelId || !isSearchCapableProvider(providerName)) return;
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
      searchCapable: true,
      searchToolType: row.searchToolType || 'web_search',
    });
  }

  function addDefaultSearchModel(rows, seen = new Set()) {
    const route = getRoute();
    const mainModel = currentMainSearchModelMeta();
    if (!mainModel || !searchCapableFor(route.provider, mainModel)) return;
    const key = `${SEARCH_DEFAULT_PROVIDER}:${SEARCH_DEFAULT_MODEL}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: SEARCH_DEFAULT_MODEL,
      provider: SEARCH_DEFAULT_PROVIDER,
      display: 'Default',
      name: 'Default',
      description: `Use current main model: ${route.provider}/${route.model}`,
      supportsWebSearch: true,
      searchCapable: true,
      searchToolType: 'web_search',
      mode: 'chat',
    });
  }

  function quickSearchProviderModelRows() {
    const route = getRoute();
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    addDefaultSearchModel(rows, seen);
    for (const [name, providerConfig] of Object.entries(pickerConfig.providers || {})) {
      const providerName = normalizeSearchProviderId(name);
      if (!providerConfig?.enabled || !isSearchCapableProvider(providerName)) continue;
      for (const model of QUICK_SEARCH_MODELS[providerName] || []) {
        addQuickSearchModel(rows, seen, providerName, model);
      }
    }
    const configuredSearch = normalizeSearchRouteConfig(pickerConfig.searchRoute) || normalizeSearchRouteConfig(getSearchRoute());
    if (configuredSearch?.provider && configuredSearch?.model) {
      addQuickSearchModel(rows, seen, configuredSearch.provider, {
        id: configuredSearch.model,
        display: configuredSearch.model,
      });
    }
    const mainModel = currentMainSearchModelMeta();
    if (mainModel && searchCapableFor(route.provider, mainModel)) {
      addQuickSearchModel(rows, seen, route.provider, {
        id: route.model,
        display: route.model,
      });
    }
    return searchModelsFromRows(rows);
  }

  function searchModelsFromRows(rows) {
    return sortProviderModels((rows || [])
      .filter((row) => row.supportsWebSearch === true)
      .map((row) => ({
        ...row,
        provider: normalizeSearchProviderId(row.provider),
        searchCapable: true,
        searchToolType: row.searchToolType || 'web_search',
      })));
  }

  function searchRowsWithDefault(rows = []) {
    const out = [];
    const seen = new Set();
    addDefaultSearchModel(out, seen);
    for (const row of rows || []) {
      const providerName = normalizeSearchProviderId(row?.provider);
      const modelId = clean(row?.id || row?.model);
      if (providerName === SEARCH_DEFAULT_PROVIDER && modelId.toLowerCase() === SEARCH_DEFAULT_MODEL) continue;
      const key = `${providerName}:${modelId}`;
      if (!providerName || !modelId || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  return {
    quickProviderModelRows,
    addQuickSearchModel,
    addDefaultSearchModel,
    quickSearchProviderModelRows,
    searchModelsFromRows,
    searchRowsWithDefault,
  };
}
