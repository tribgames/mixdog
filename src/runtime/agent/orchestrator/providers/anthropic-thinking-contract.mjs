// One classification owns request shaping and manual-budget validation.
export function isAnthropicAdaptiveOnlyModel(model) {
    const id = String(model || '').toLowerCase().replace(/\./g, '-');
    return /^claude-(?:fable|mythos)-5(?:-|$)/.test(id)
        || /^claude-(?:opus|sonnet)-5(?:-|$)/.test(id)
        || /^claude-opus-4-(?:7|8)(?:-|$)/.test(id);
}

export function assertAnthropicManualBudgetSupported(model) {
    if (isAnthropicAdaptiveOnlyModel(model)) {
        throw new TypeError(`${model} does not support thinkingBudgetTokens; use effort with adaptive thinking instead.`);
    }
}
