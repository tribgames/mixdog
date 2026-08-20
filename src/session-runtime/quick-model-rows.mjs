// Quick (offline) provider/model picker row builders, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory: closes over
// route/config/web-search accessors and shared row helpers supplied by the facade.
import { clean } from './session-text.mjs';
import { QUICK_WEB_SEARCH_MODELS } from './quick-web-search-models.mjs';
import { WEB_SEARCH_DEFAULT_PROVIDER, WEB_SEARCH_DEFAULT_MODEL } from './workflow.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { providerCachedModelsSync } from '../runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';

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
  function quickProviderModelRows() {
    const route = getRoute();
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    const addModel = (provider, modelLike = {}) => {
      const model = modelLike && typeof modelLike === 'object'
        ? modelLike
        : { id: clean(modelLike) };
      const modelId = clean(model.id || model.name);
      if (!provider || !modelId) return;
      const key = `${provider}:${modelId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const meta = metadataFor(provider, modelId);
      const row = providerModelCacheRow(provider, {
        ...model,
        id: modelId,
        name: model.name || model.display || modelId,
        display: model.display || model.name || modelId,
        contextWindow: model.contextWindow || meta.contextWindow || null,
        outputTokens: model.outputTokens || meta.outputTokens || null,
        supportsReasoning: model.supportsReasoning === true || meta.supportsReasoning === true,
        supportsFunctionCalling: model.supportsFunctionCalling === true || meta.supportsFunctionCalling === true,
        supportsPromptCaching: model.supportsPromptCaching === true || meta.supportsPromptCaching === true,
        reasoningOptions: model.reasoningOptions?.length ? model.reasoningOptions : (meta.reasoningOptions || []),
        reasoningContentField: model.reasoningContentField || meta.reasoningContentField || null,
        mode: model.mode || meta.mode || 'chat',
      });
      rows.push(row);
      modelMetaByRoute.set(modelMetaKey(provider, modelId), row);
    };
    const addRoute = (routeLike = {}) => {
      const provider = clean(routeLike.provider);
      const model = clean(routeLike.model);
      if (!provider || !model) return;
      const meta = metadataFor(provider, model);
      addModel(provider, {
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
    };

    for (const [provider, providerConfig] of Object.entries(pickerConfig.providers || {})) {
      if (!providerConfig?.enabled) continue;
      for (const model of providerCachedModelsSync(provider)) addModel(provider, model);
    }
    addRoute(route);
    for (const preset of pickerConfig.presets || []) addRoute(preset);
    for (const workflowRoute of Object.values(pickerConfig.workflowRoutes || {})) addRoute(workflowRoute);
    for (const agentRoute of Object.values(pickerConfig.agents || {})) addRoute(agentRoute);
    return providerModelsFromCacheRows(rows);
  }

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
      const quickModels = cachedModels.length
        ? cachedModels
        : (QUICK_WEB_SEARCH_MODELS[providerName] || []);
      for (const model of quickModels) {
        addQuickWebSearchModel(rows, seen, providerName, model);
      }
    }
    const configuredWebSearch = normalizeWebSearchRouteConfig(pickerConfig.webSearchRoute) || normalizeWebSearchRouteConfig(getWebSearchRoute());
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

  function webSearchModelsFromRows(rows) {
    return sortProviderModels((rows || [])
      .filter((row) => row.supportsWebSearch === true)
      .map((row) => ({
        ...row,
        provider: normalizeWebSearchProviderId(row.provider),
        webSearchCapable: true,
        webSearchToolType: row.webSearchToolType || 'web_search',
      })));
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
    quickProviderModelRows,
    addQuickWebSearchModel,
    addDefaultWebSearchModel,
    quickWebSearchProviderModelRows,
    webSearchModelsFromRows,
    webSearchRowsWithDefault,
  };
}
