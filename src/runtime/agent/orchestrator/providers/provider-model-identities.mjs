// Model identities are shared by transport and pricing. Keep this module
// independent of credentials, tracing and provider initialization.
function fallbackModel(id, display, family, contextWindow, wire) {
    const tiered = wire && typeof wire === 'object';
    return {
        id,
        name: display,
        display,
        provider: 'antigravity-oauth',
        ...(family ? { family } : {}),
        contextWindow,
        supportsVision: true,
        supportsReasoning: true,
        supportsFunctionCalling: true,
        reasoningLevels: tiered ? Object.keys(wire) : [],
        wire,
    };
}

export const ANTIGRAVITY_MODELS = Object.freeze([
    fallbackModel('gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini-flash', 1048576, {
        low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high',
    }),
    fallbackModel('gemini-3.1-pro', 'Gemini 3.1 Pro', 'gemini-pro', 1048576, {
        low: 'gemini-3.1-pro-low', high: 'gemini-3.1-pro-high',
    }),
    fallbackModel('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', null, 250000, 'claude-opus-4-6-thinking'),
    fallbackModel('claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)', null, 250000, 'claude-sonnet-4-6'),
    fallbackModel('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', 'gpt-oss', 131072, 'gpt-oss-120b-medium'),
]);

// Exact aliases accepted by the Grok transport; never infer deployment aliases.
const RETIRED_MODEL_ALIASES = Object.freeze({
    'grok-code-fast-1': 'grok-build-0.1',
    'grok-code-fast': 'grok-build-0.1',
    'grok-code-fast-1-0825': 'grok-build-0.1',
});
export function normalizeGrokModelId(id) {
    return (id && RETIRED_MODEL_ALIASES[id]) || id;
}
