// Shared request service-tier resolver for every OpenAI send path.
// fast === true → 'ultrafast' when modelParameters.serviceTier asks for it and
// the model supports it on this route; otherwise 'priority' when fast-capable;
// otherwise no tier. `provider` is 'openai' (public API) or 'openai-oauth'.
import { codexModelSupportsServiceTier } from './openai-oauth-catalog.mjs';
import { openAiDirectSupportsFast, openAiDirectSupportsUltrafast } from './openai-direct-request.mjs';

export function resolveOpenAiServiceTier(provider, model, opts) {
  if (opts?.fast !== true) return '';
  const direct = provider === 'openai';
  const supports = (tier) =>
    direct
      ? tier === 'ultrafast'
        ? openAiDirectSupportsUltrafast(model)
        : openAiDirectSupportsFast(model)
      : codexModelSupportsServiceTier(model, tier);
  if (opts.modelParameters?.serviceTier === 'ultrafast' && supports('ultrafast')) return 'ultrafast';
  return supports('priority') ? 'priority' : '';
}
