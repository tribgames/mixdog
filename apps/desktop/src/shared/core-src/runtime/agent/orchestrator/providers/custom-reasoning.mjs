// Per-model reasoning settings for user-defined (`custom-*`) providers. Pure:
// the effective model row (custom-provider getCachedModelInfo) carries the
// supported levels and the wire mapping; this module snaps the requested
// effort to a supported level and serializes it for the provider protocol.
// First-party providers never route through here.

import { isTogetherBaseURL } from './openai-compat-reasoning-field.mjs';

export const CUSTOM_EFFORT_LEVELS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const RANK = new Map(CUSTOM_EFFORT_LEVELS.map((level, index) => [level, index]));

export function isCustomProviderName(name) {
  return String(name || '').startsWith('custom-');
}

/** One effort token in the custom vocabulary (`ultra` → `max`), or null. */
export function normalizeCustomEffort(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  const level = v === 'ultra' ? 'max' : v;
  return RANK.has(level) ? level : null;
}

/**
 * Supported levels declared on the row, ranked and deduplicated, or null when
 * the row declares none (unknown). An explicit [] stays [] (no reasoning).
 */
export function customEffortLevels(model) {
  const option = Array.isArray(model?.reasoningOptions)
    ? model.reasoningOptions.find(
        (entry) =>
          String(entry?.type || '')
            .trim()
            .toLowerCase() === 'effort'
      )
    : null;
  let raw = null;
  if (Array.isArray(option?.values)) raw = option.values;
  else if (Array.isArray(model?.reasoningLevels)) raw = model.reasoningLevels;
  if (!raw) return null;
  const levels = new Set(raw.map(normalizeCustomEffort).filter(Boolean));
  return CUSTOM_EFFORT_LEVELS.filter((level) => levels.has(level));
}

/**
 * Snap a requested effort onto `levels`. Exact matches stay; `none` is kept
 * only when supported; otherwise the strongest supported non-none level not
 * stronger than the request. Never promotes; no eligible level → null.
 */
export function snapCustomEffort(levels, effort) {
  const requested = normalizeCustomEffort(effort);
  if (!requested || !Array.isArray(levels) || levels.length === 0) return null;
  const supported = levels.map(normalizeCustomEffort).filter(Boolean);
  if (supported.includes(requested)) return requested;
  if (requested === 'none') return null;
  const ceiling = RANK.get(requested);
  let best = null;
  for (const level of supported) {
    const rank = RANK.get(level);
    if (level === 'none' || rank === undefined || rank > ceiling) continue;
    if (best === null || rank > RANK.get(best)) best = level;
  }
  return best;
}

const EMPTY = Object.freeze({ level: null, fields: {}, thinking: null, replay: false });
// Chat-only extensions on top of the standard `reasoning_effort`.
const CHAT_ONLY_WIRE_FORMATS = new Set(['deepseek', 'together', 'vllm']);

/**
 * The effective wire format of a row: its declared format, else `together`
 * when the provider's own base URL is Together AI (whose hybrid models toggle
 * reasoning with a `reasoning.enabled` flag), else `standard`.
 */
export function customWireFormat(model, baseURL) {
  const declared = model?.customReasoning?.wireFormat;
  if (CHAT_ONLY_WIRE_FORMATS.has(declared)) return declared;
  return isTogetherBaseURL(baseURL) ? 'together' : 'standard';
}

/**
 * @param {{ protocol: 'openai-chat'|'openai-responses'|'anthropic', model: object|null, effort: string|null|undefined, baseURL?: string }} input
 * @returns {{ level: string|null, fields: object, thinking: 'on'|'off'|null, replay: boolean }}
 */
export function resolveCustomReasoning({ protocol, model, effort, baseURL } = {}) {
  const custom = model?.customReasoning || {};
  const wireFormat = protocol === 'openai-chat' ? customWireFormat(model, baseURL) : 'standard';
  // The `thinking` / `reasoning.enabled` / chat_template_kwargs extensions
  // exist only on the Chat wire.
  if (CHAT_ONLY_WIRE_FORMATS.has(custom.wireFormat) && protocol !== 'openai-chat') return { ...EMPTY, fields: {} };
  const level = snapCustomEffort(customEffortLevels(model), effort);
  let thinking = null;
  if (level !== null) thinking = level === 'none' ? 'off' : 'on';
  const mapped = level === null ? null : custom.wireValues?.[level];
  const value = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : level;
  let fields = {};
  if (level !== null) {
    if (protocol === 'openai-chat') {
      if (wireFormat === 'deepseek') {
        fields =
          level === 'none'
            ? { thinking: { type: 'disabled' } }
            : { thinking: { type: 'enabled' }, reasoning_effort: value };
      } else if (wireFormat === 'together') {
        // Together: `reasoning.enabled` toggles hybrid models (those that can
        // be turned off); `reasoning_effort` sets the depth of the others.
        if (level === 'none') fields = { reasoning: { enabled: false } };
        else {
          fields = { reasoning_effort: value };
          if (customEffortLevels(model)?.includes('none')) fields.reasoning = { enabled: true };
        }
      } else if (wireFormat === 'vllm') {
        // vLLM switches thinking through the chat template.
        fields = { chat_template_kwargs: { enable_thinking: level !== 'none' } };
        if (level !== 'none') fields.reasoning_effort = value;
      } else {
        fields = { reasoning_effort: value };
      }
    } else if (protocol === 'openai-responses') {
      fields = { reasoning: { effort: value } };
    } else if (protocol === 'anthropic') {
      fields =
        level === 'none'
          ? { thinking: { type: 'disabled' } }
          : { thinking: { type: 'adaptive' }, output_config: { effort: value } };
    }
  }
  // An explicit replay flag wins over the catalog's reasoning_content field.
  const replayFlag =
    typeof custom.replay === 'boolean' ? custom.replay : model?.reasoningContentField === 'reasoning_content';
  const replay = protocol === 'openai-chat' && replayFlag && thinking !== 'off';
  return { level, fields, thinking, replay };
}
