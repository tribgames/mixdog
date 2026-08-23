function normalizedModelId(value) {
    const raw = typeof value === 'string'
        ? value
        : value && typeof value === 'object'
            ? value.model
            : '';
    return typeof raw === 'string' ? raw.trim() : '';
}

export function supportsAnthropicServerFallback(model) {
    const id = normalizedModelId(model).toLowerCase().replace(/\./g, '-');
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
    const trigger = block.trigger && typeof block.trigger === 'object'
        ? block.trigger
        : null;
    const triggerType = typeof trigger?.type === 'string' && trigger.type.trim()
        ? trigger.type.trim()
        : 'refusal';
    const category = typeof trigger?.category === 'string' && trigger.category.trim()
        ? trigger.category.trim()
        : null;
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
