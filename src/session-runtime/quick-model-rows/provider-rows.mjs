// Quick (offline) main-model picker rows: every enabled provider's cached
// models plus the routes the profile already names (current, presets,
// workflow and agent routes), deduplicated per provider:model.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { providerCachedModelsSync } from '../../runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';
import {
  effectiveCustomModelRows,
  normalizeCustomProviderConfig,
} from '../../runtime/agent/orchestrator/providers/custom-provider.mjs';
import { declaredCustomFields, metadataFor } from './model-meta.mjs';

// A custom provider's picker models: its effective rows (discovered + saved
// overrides + manual models), read from the v2 config; a legacy `models`
// config is migrated by the normalizer. A config that does not normalize
// cannot run, so it lists nothing. `discovered` defaults to the cached catalog;
// a saved route on an uncached model passes its own row so the same overrides
// (hidden, metadata, reasoning) apply to it as in the full catalog.
function customProviderModels(provider, providerConfig, discovered = providerCachedModelsSync(provider)) {
  let config;
  try {
    config = normalizeCustomProviderConfig(providerConfig);
  } catch {
    return [];
  }
  const providerName = clean(config.name);
  return effectiveCustomModelRows(config, discovered, { providerId: provider }).map((row) =>
    providerName ? { ...row, providerName } : row
  );
}

export function createQuickProviderRows({
  getRoute,
  displayConfig,
  providerModelCacheRow,
  providerModelsFromCacheRows,
  modelMetaByRoute,
  modelMetaKey,
}) {
  return function quickProviderModelRows() {
    const route = getRoute();
    const pickerConfig = displayConfig();
    const rows = [];
    const seen = new Set();
    const addModel = (provider, modelLike = {}) => {
      const model = modelLike && typeof modelLike === 'object' ? modelLike : { id: clean(modelLike) };
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
        // An explicit value (an override's false included) wins; the catalog fills the rest.
        supportsVision: model.supportsVision ?? meta.supportsVision,
        supportsReasoning: model.supportsReasoning === true || meta.supportsReasoning === true,
        supportsFunctionCalling: model.supportsFunctionCalling === true || meta.supportsFunctionCalling === true,
        supportsPromptCaching: model.supportsPromptCaching === true || meta.supportsPromptCaching === true,
        reasoningOptions: model.reasoningOptions?.length ? model.reasoningOptions : meta.reasoningOptions || [],
        reasoningContentField: model.reasoningContentField || meta.reasoningContentField || null,
        mode: model.mode || meta.mode || 'chat',
        ...declaredCustomFields(provider, model),
      });
      modelMetaByRoute.set(modelMetaKey(provider, modelId), row);
      // A hidden model leaves the picker (a saved route on it included) while
      // its metadata keeps resolving for sessions already on it.
      if (row.hidden !== true) rows.push(row);
    };
    const addRoute = (routeLike = {}) => {
      const provider = clean(routeLike.provider);
      const model = clean(routeLike.model);
      if (!provider || !model || isDeletedCustom(provider)) return;
      const meta = metadataFor(provider, model);
      const routeRow = {
        id: model,
        name: routeLike.modelDisplay || routeLike.display || model,
        display: routeLike.modelDisplay || routeLike.display || model,
        contextWindow: meta.contextWindow || null,
        outputTokens: meta.outputTokens || null,
        latest: routeLike.latest === true,
        supportsVision: meta.supportsVision,
        supportsReasoning: !!routeLike.effort || meta.supportsReasoning === true,
        supportsFunctionCalling: meta.supportsFunctionCalling === true,
        supportsPromptCaching: meta.supportsPromptCaching === true,
        reasoningOptions: meta.reasoningOptions || [],
        reasoningContentField: meta.reasoningContentField || null,
        mode: 'chat',
      };
      const customConfig = customProviders[provider];
      if (customConfig?.type === 'custom') {
        const row = customProviderModels(provider, customConfig, [routeRow]).find((item) => item.id === model);
        if (row) addModel(provider, row);
        return;
      }
      addModel(provider, routeRow);
    };

    // A custom-* id with no live custom config entry was deleted: stale
    // routes must not bring it back into the picker.
    const customProviders = pickerConfig.providers || {};
    const isDeletedCustom = (provider) =>
      provider.startsWith('custom-') &&
      !(customProviders[provider]?.type === 'custom' && customProviders[provider].enabled !== false);
    for (const [provider, providerConfig] of Object.entries(customProviders)) {
      if (!providerConfig?.enabled) continue;
      // Configured custom models are listed at once, before any catalog refresh.
      const models =
        providerConfig.type === 'custom'
          ? customProviderModels(provider, providerConfig)
          : providerCachedModelsSync(provider);
      for (const model of models) addModel(provider, model);
    }
    addRoute(route);
    for (const preset of pickerConfig.presets || []) addRoute(preset);
    for (const workflowRoute of Object.values(pickerConfig.workflowRoutes || {})) addRoute(workflowRoute);
    for (const agentRoute of Object.values(pickerConfig.agents || {})) addRoute(agentRoute);
    return providerModelsFromCacheRows(rows);
  };
}
