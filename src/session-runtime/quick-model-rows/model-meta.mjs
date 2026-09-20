// Offline model metadata for quick picker rows: the sync catalog lookup and a
// model record filled from it.
import { clean } from '../session-text.mjs';
import { getModelMetadataSync } from '../../runtime/agent/orchestrator/providers/model-catalog.mjs';

export function metadataFor(provider, modelId) {
  try {
    return getModelMetadataSync(modelId, provider) || {};
  } catch {
    return {};
  }
}

export function hydratedModel(provider, model = {}) {
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
    reasoningOptions:
      Array.isArray(base?.reasoningOptions) && base.reasoningOptions.length
        ? base.reasoningOptions
        : meta.reasoningOptions || [],
    reasoningContentField: base?.reasoningContentField || meta.reasoningContentField || null,
  };
}
