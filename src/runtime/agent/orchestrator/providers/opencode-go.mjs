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

export function isAnthropicGoModel(model) {
    const id = String(model || '').toLowerCase();
    return ANTHROPIC_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}

export function resolveOpenCodeGoBaseURLs(configuredBaseURL) {
    const presetBase = OPENAI_COMPAT_PRESETS['opencode-go'].baseURL;
    const openai = String(configuredBaseURL || presetBase).replace(/\/+$/, '');
    // Anthropic's SDK appends `/v1/messages` itself. Supplying the OpenAI base
    // (`.../v1`) would therefore produce the invalid `.../v1/v1/messages`.
    const anthropic = openai.replace(/\/v1$/i, '');
    return { openai, anthropic };
}

export function openCodeGoEndpointForModel(model, configuredBaseURL) {
    const bases = resolveOpenCodeGoBaseURLs(configuredBaseURL);
    return isAnthropicGoModel(model)
        ? `${bases.anthropic}/v1/messages`
        : `${bases.openai}/chat/completions`;
}

function normalizeOpenCodeGoResultUsage(result, anthropicRoute) {
    if (!anthropicRoute || !result?.usage) return result;
    const usage = result.usage;
    const input = Number(usage.inputTokens) || 0;
    const cached = Number(usage.cachedTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const inclusiveInput = input + cached + cacheWrite;
    return {
        ...result,
        usage: {
            ...usage,
            inputTokens: inclusiveInput,
            promptTokens: Math.max(Number(usage.promptTokens) || 0, inclusiveInput),
        },
    };
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
    config;
    openai;
    anthropic;

    constructor(config = {}) {
        // Retain the outer account config for the common provider-admission
        // lane. The delegated transports are intentionally not independently
        // wrapped, so all model-family routes share this one 64-wide account.
        this.config = config;
        const preset = OPENAI_COMPAT_PRESETS['opencode-go'];
        const bases = resolveOpenCodeGoBaseURLs(config.baseURL || preset.baseURL);
        this.openai = new OpenAICompatProvider('opencode-go', { ...config, baseURL: bases.openai });
        this.anthropic = new AnthropicProvider({
            ...config,
            name: 'opencode-go',
            baseURL: bases.anthropic,
            disableBetaHeaders: true,
        });
    }

    async send(messages, model, tools, sendOpts) {
        if (isAnthropicGoModel(model)) {
            const result = await this.anthropic.send(messages, model, tools, {
                ...(sendOpts || {}),
                cacheStrategy: {
                    tools: 'none',
                    system: 'none',
                    tier3: 'none',
                    messages: 'none',
                },
            });
            return normalizeOpenCodeGoResultUsage(result, true);
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
