import {
  normalizeXaiReasoningEffort,
  xaiModelSupportsReasoningEffort,
  normalizeOpencodeGoReasoningEffort,
} from './openai-compat-xai.mjs';

function normalizeReasoningEffort(value, allowed) {
  const effort = String(value ?? '')
    .trim()
    .toLowerCase();
  return allowed.includes(effort) ? effort : null;
}

// Keep provider extensions isolated: fields accepted by one OpenAI-compatible
// backend are frequently rejected by another even when the core Chat schema
// is shared.
export function applyCompatProviderChatOptions(params, providerName, opts = {}, config = {}, modelInfo = null) {
  if (providerName === 'openrouter') {
    const effort = normalizeReasoningEffort(opts.openRouterReasoningEffort ?? opts.effort ?? config?.reasoningEffort, [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    if (effort === 'none') params.reasoning = { enabled: false };
    else if (effort) params.reasoning = { enabled: true, effort };
    return params;
  }
  if (providerName === 'xai') {
    const reasoningEffort = normalizeXaiReasoningEffort(
      opts.xaiReasoningEffort ?? opts.effort ?? config?.reasoningEffort ?? process.env.MIXDOG_XAI_REASONING_EFFORT
    );
    // grok-3/grok-4/grok-4-fast reject the parameter with a 400, so the
    // model decides whether it ships at all.
    if (reasoningEffort && xaiModelSupportsReasoningEffort(params.model)) {
      params.reasoning_effort = reasoningEffort;
    }
    return params;
  }
  if (providerName === 'deepseek') {
    const rawThinking = opts.deepseekThinking ?? opts.thinking ?? config?.thinking;
    const rawEffort = opts.deepseekReasoningEffort ?? opts.effort ?? config?.reasoningEffort;
    if (rawThinking !== undefined || rawEffort !== undefined) {
      const disabled =
        rawThinking === false ||
        String(rawThinking?.type ?? rawThinking ?? rawEffort)
          .trim()
          .toLowerCase() === 'disabled' ||
        String(rawThinking?.type ?? rawThinking ?? rawEffort)
          .trim()
          .toLowerCase() === 'none';
      params.thinking = { type: disabled ? 'disabled' : 'enabled' };
      if (!disabled) {
        const effort = String(rawEffort ?? '')
          .trim()
          .toLowerCase();
        if (effort === 'max') params.reasoning_effort = 'max';
        // DeepSeek documents low/high/max; `medium` is its own alias for
        // high, and `low` is a real level that must not be promoted.
        else if (effort === 'low') params.reasoning_effort = 'low';
        else if (['medium', 'high', 'xhigh'].includes(effort)) params.reasoning_effort = 'high';
      }
    }
    return params;
  }
  if (providerName === 'opencode-go') {
    const reasoningEffort = normalizeOpencodeGoReasoningEffort(opts.effort ?? config?.reasoningEffort, modelInfo);
    // OpenCode Go's OpenAI-compatible contract exposes reasoning_effort,
    // not DeepSeek's provider-specific `thinking` extension.
    if (reasoningEffort) params.reasoning_effort = reasoningEffort;
  }
  return params;
}
