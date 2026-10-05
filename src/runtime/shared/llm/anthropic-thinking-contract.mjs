/** Lowercased model id with dots folded to dashes (claude-opus-4.8 → claude-opus-4-8). */
export function normalizeClaudeModelId(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/\./g, '-');
}

// One classification owns request shaping and manual-budget validation.
export function isAnthropicAdaptiveOnlyModel(model) {
  const id = normalizeClaudeModelId(model);
  return (
    /^claude-(?:fable|mythos)-5(?:-|$)/.test(id) ||
    /^claude-(?:opus|sonnet)-5(?:-|$)/.test(id) ||
    /^claude-opus-4-(?:7|8)(?:-|$)/.test(id)
  );
}

// Models that write their user-facing notes between tool calls (tool
// preambles) as progress-update thinking blocks instead of text blocks.
export function emitsAnthropicProgressUpdates(model) {
  const id = normalizeClaudeModelId(model);
  return /^claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1|fable-5)(?:-\d{8})?$/.test(id);
}

export function assertAnthropicManualBudgetSupported(model) {
  if (isAnthropicAdaptiveOnlyModel(model)) {
    throw new TypeError(`${model} does not support thinkingBudgetTokens; use effort with adaptive thinking instead.`);
  }
}
