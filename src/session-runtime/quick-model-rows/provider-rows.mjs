// Quick (offline) main-model picker rows: every enabled provider's cached
// models plus the routes the profile already names (current, presets,
// workflow and agent routes), deduplicated per provider:model.
import { clean } from '../session-text.mjs';
import { providerCachedModelsSync } from '../../runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';
import { metadataFor } from './model-meta.mjs';

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
        supportsReasoning: model.supportsReasoning === true || meta.supportsReasoning === true,
        supportsFunctionCalling: model.supportsFunctionCalling === true || meta.supportsFunctionCalling === true,
        supportsPromptCaching: model.supportsPromptCaching === true || meta.supportsPromptCaching === true,
        reasoningOptions: model.reasoningOptions?.length ? model.reasoningOptions : meta.reasoningOptions || [],
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
  };
}
