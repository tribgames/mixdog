// Offline model metadata for quick picker rows: the sync catalog lookup and a
// model record filled from it.
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { getModelMetadataSync } from '../../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { isCustomProviderName } from '../../runtime/agent/orchestrator/providers/custom-reasoning.mjs';

const CUSTOM_DECLARED_FIELDS = [
  'supportsVision',
  'supportsReasoning',
  'reasoningOptions',
  'reasoningLevels',
  'reasoningContentField',
  'providerName',
  'hidden',
  'manual',
  'customReasoning',
];

/** A custom provider's effective row is authoritative: every contract field it
 *  states (an explicit [] or false included) wins over catalog metadata, and
 *  declared levels are not overridden by catalog effort options. First-party
 *  rows get nothing here. */
export function declaredCustomFields(provider, model) {
  if (!isCustomProviderName(provider) || !model || typeof model !== 'object') return {};
  const out = {};
  for (const key of CUSTOM_DECLARED_FIELDS) {
    if (Object.hasOwn(model, key) && model[key] !== undefined) out[key] = model[key];
  }
  if (Object.hasOwn(out, 'reasoningLevels') && !Object.hasOwn(out, 'reasoningOptions')) out.reasoningOptions = [];
  return out;
}

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
    ...declaredCustomFields(provider, base),
  };
}
