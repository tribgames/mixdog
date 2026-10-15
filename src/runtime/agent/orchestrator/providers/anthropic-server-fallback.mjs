import { normalizeClaudeModelId } from './anthropic-thinking-contract.mjs';

function normalizedModelId(value) {
  if (typeof value === 'string') return value.trim();
  const raw = value && typeof value === 'object' ? value.model : '';
  return typeof raw === 'string' ? raw.trim() : '';
}

// Kept as an id pattern: no catalog field declares server-side fallback, and
// `fallbacks` is a beta-gated body field other models reject (a wrong "yes" is
// a 400, a wrong "no" only skips an optional refusal fallback), so unknown ids
// stay off.
export function supportsAnthropicServerFallback(model) {
  const id = normalizeClaudeModelId(normalizedModelId(model));
  return /^claude-(?:opus|fable)-5(?:$|[-@])/.test(id);
}

export function applyAnthropicServerFallback(body, model, { enabled = true } = {}) {
  if (!body || typeof body !== 'object' || !enabled || !supportsAnthropicServerFallback(model)) {
    return false;
  }
  body.fallbacks = 'default';
  return true;
}

export function parseAnthropicFallbackBlock(block) {
  if (!block || typeof block !== 'object' || block.type !== 'fallback') return null;
  const originalModel = normalizedModelId(block.from);
  const fallbackModel = normalizedModelId(block.to);
  if (!originalModel || !fallbackModel) return null;
  const trigger = block.trigger && typeof block.trigger === 'object' ? block.trigger : null;
  const triggerType = typeof trigger?.type === 'string' && trigger.type.trim() ? trigger.type.trim() : 'refusal';
  const category = typeof trigger?.category === 'string' && trigger.category.trim() ? trigger.category.trim() : null;
  return {
    trigger: triggerType,
    originalModel,
    fallbackModel,
    ...(category ? { category } : {}),
  };
}

export function anthropicFallbackProviderMetadata(events) {
  const fallbacks = Array.isArray(events) ? events.filter(Boolean) : [];
  return fallbacks.length ? { anthropicFallbacks: fallbacks } : undefined;
}
