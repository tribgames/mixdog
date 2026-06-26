import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider, OPENAI_COMPAT_PRESETS } from './openai-compat.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';

// OpenCode Go publishes both OpenAI-compatible and Anthropic-compatible
// endpoints. Route by model family so the CLI matches the official surface
// instead of forcing every model through /chat/completions.
const ANTHROPIC_MODEL_PREFIXES = [
    'minimax-',
    'qwen',
];

const OPENCODE_GO_CONTEXT_WINDOWS = Object.freeze({
    // OpenCode models catalog fixture / models.dev opencode-go provider rows.
    'minimax-m2.7': 204800,
    'minimax-m2-7': 204800,
    'kimi-k2.5': 262144,
    'kimi-k2-5': 262144,
    'mimo-v2.5-pro': 1048576,
    'glm-5': 202752,
});

function isAnthropicGoModel(model) {
    const id = String(model || '').toLowerCase();
    return ANTHROPIC_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}

function opencodeGoContextWindow(_modelId, current = 0) {
    const native = Number(current);
    if (Number.isFinite(native) && native > 0) return native;
    const fallback = OPENCODE_GO_CONTEXT_WINDOWS[String(_modelId || '').toLowerCase()];
    if (fallback) return fallback;
    const catalog = getModelMetadataSync(_modelId, 'opencode-go');
    const contextWindow = Number(catalog?.contextWindow);
    if (Number.isFinite(contextWindow) && contextWindow > 0) return Math.floor(contextWindow);
    return 0;
}

function opencodeGoReasoningLevels(model, current = null) {
    if (Array.isArray(current) && current.length > 0) return current;
    const effort = (model?.reasoningOptions || []).find((option) => option?.type === 'effort');
    if (Array.isArray(effort?.values)) return effort.values.map((value) => String(value || '').trim()).filter(Boolean);
    return [];
}

export class OpenCodeGoProvider {
    static inputExcludesCache = false;
    name = 'opencode-go';
    openai;
    anthropic;

    constructor(config = {}) {
        const preset = OPENAI_COMPAT_PRESETS['opencode-go'];
        const baseURL = config.baseURL || preset.baseURL;
        this.openai = new OpenAICompatProvider('opencode-go', { ...config, baseURL });
        this.anthropic = new AnthropicProvider({
            ...config,
            name: 'opencode-go',
            baseURL,
            disableBetaHeaders: true,
        });
    }

    async send(messages, model, tools, sendOpts) {
        if (isAnthropicGoModel(model)) {
            return this.anthropic.send(messages, model, tools, {
                ...(sendOpts || {}),
                cacheStrategy: {
                    tools: 'none',
                    system: 'none',
                    tier3: 'none',
                    messages: 'none',
                },
            });
        }
        return this.openai.send(messages, model, tools, sendOpts);
    }

    async listModels() {
        const models = await this.openai.listModels();
        return Array.isArray(models)
            ? models.map((model) => ({
                ...model,
                contextWindow: opencodeGoContextWindow(model?.id, model?.contextWindow),
                reasoningLevels: opencodeGoReasoningLevels(model, model?.reasoningLevels),
            }))
            : models;
    }

    getCachedModelInfo(model) {
        const inner = isAnthropicGoModel(model) ? this.anthropic : this.openai;
        const cached = typeof inner.getCachedModelInfo === 'function'
            ? inner.getCachedModelInfo(model)
            : null;
        const catalog = getModelMetadataSync(model, 'opencode-go');
        const info = cached || catalog || null;
        if (!info) {
            return null;
        }
        const contextWindow = opencodeGoContextWindow(model, info.contextWindow);
        return {
            ...info,
            id: info.id || model,
            provider: this.name,
            contextWindow: contextWindow || info.contextWindow || null,
            reasoningLevels: opencodeGoReasoningLevels(info, info.reasoningLevels),
        };
    }
}
