import {
  normalizeXaiReasoningEffort,
  xaiModelSupportsReasoningEffort,
  normalizeOpencodeGoReasoningEffort,
} from './openai-compat-xai.mjs';
import { isCustomProviderName, resolveCustomReasoning } from './custom-reasoning.mjs';

function normalizeReasoningEffort(value, allowed) {
  const effort = String(value ?? '')
    .trim()
    .toLowerCase();
  return allowed.includes(effort) ? effort : null;
}

/**
 * OpenRouter's unified `reasoning` field, shared by its Chat and Responses
 * wires: `openRouterReasoningEffort`, else the turn effort, else the configured
 * effort; `none` disables reasoning. Null when no effort applies.
 */
export function openRouterReasoning(opts = {}, config = {}) {
  const effort = normalizeReasoningEffort(opts.openRouterReasoningEffort ?? opts.effort ?? config?.reasoningEffort, [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  if (effort === 'none') return { enabled: false };
  return effort ? { enabled: true, effort } : null;
}

function deepseekRawEffort(opts, config) {
  return opts.deepseekReasoningEffort ?? opts.effort ?? config?.reasoningEffort;
}

/** 'enabled' | 'disabled' as the DeepSeek request will carry it, or null when nothing sets it. */
export function deepseekThinkingMode(opts = {}, config = {}) {
  const rawThinking = opts.deepseekThinking ?? opts.thinking ?? config?.thinking;
  const rawEffort = deepseekRawEffort(opts, config);
  if (rawThinking === undefined && rawEffort === undefined) return null;
  const thinkingMode = String(rawThinking?.type ?? rawThinking ?? rawEffort)
    .trim()
    .toLowerCase();
  const disabled = rawThinking === false || thinkingMode === 'disabled' || thinkingMode === 'none';
  return disabled ? 'disabled' : 'enabled';
}

// Keep provider extensions isolated: fields accepted by one OpenAI-compatible
// backend are frequently rejected by another even when the core Chat schema
// is shared.
export function applyCompatProviderChatOptions(params, providerName, opts = {}, config = {}, modelInfo = null) {
  if (isCustomProviderName(providerName)) {
    // User-defined provider: the model row's reasoning settings decide the
    // level and its wire shape (custom-reasoning.mjs).
    const { fields } = resolveCustomReasoning({
      protocol: 'openai-chat',
      model: modelInfo,
      effort: opts.effort ?? config?.reasoningEffort,
      baseURL: config?.baseURL,
    });
    Object.assign(params, fields);
    return params;
  }
  if (providerName === 'openrouter') {
    const reasoning = openRouterReasoning(opts, config);
    if (reasoning) params.reasoning = reasoning;
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
    const mode = deepseekThinkingMode(opts, config);
    if (mode) {
      params.thinking = { type: mode };
      if (mode === 'enabled') {
        const effort = String(deepseekRawEffort(opts, config) ?? '')
          .trim()
          .toLowerCase();
        // DeepSeek documents low/high/max; `ultra` is its alias for max,
        // `minimal` for low, `medium`/`xhigh` for high; `low` must not be promoted.
        if (effort === 'max' || effort === 'ultra') params.reasoning_effort = 'max';
        else if (effort === 'low' || effort === 'minimal') params.reasoning_effort = 'low';
        else if (['medium', 'high', 'xhigh'].includes(effort)) params.reasoning_effort = 'high';
      }
    }
    return params;
  }
  if (providerName === 'command-code-oauth') {
    // The API's field is undocumented; mirror the common `reasoning_effort`
    // (levels the catalog row declares, else low/medium/high).
    const rawEffort = opts.effort ?? config?.reasoningEffort;
    const declared = modelInfo?.reasoningOptions?.some((option) => option?.type === 'effort');
    const effort = declared
      ? normalizeOpencodeGoReasoningEffort(rawEffort, modelInfo)
      : normalizeReasoningEffort(rawEffort, ['low', 'medium', 'high']);
    if (effort) params.reasoning_effort = effort;
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
