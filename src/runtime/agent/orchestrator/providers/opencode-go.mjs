import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider, OPENAI_COMPAT_PRESETS } from './openai-compat.mjs';
import { getModelMetadataSync, getModelsDevRowSync } from './model-catalog.mjs';

// OpenCode Go publishes OpenAI chat/completions, OpenAI Responses, and
// Anthropic Messages endpoints, and each upstream brand answers on only one
// of them (muse-spark / gpt / grok 500 on chat/completions; minimax expects
// Messages). models.dev names the SDK package per model, which is the
// authoritative wire selector; the prefix tables are the cold-catalog fallback.
const ANTHROPIC_MODEL_PREFIXES = [
    'minimax-',
    'qwen',
];
const RESPONSES_MODEL_PREFIXES = [
    'muse-spark-',
    'gpt-',
    'grok-',
];
const WIRE_API_BY_NPM = Object.freeze({
    '@ai-sdk/openai': 'responses',
    '@ai-sdk/anthropic': 'messages',
    '@ai-sdk/openai-compatible': 'chat',
});

/** Wire API for a Go model: 'responses' | 'messages' | 'chat'. */
export function openCodeGoWireApi(model) {
    const id = String(model || '').toLowerCase();
    const npm = getModelsDevRowSync(String(model || ''), 'opencode-go')?.npm;
    if (npm && WIRE_API_BY_NPM[npm]) return WIRE_API_BY_NPM[npm];
    if (RESPONSES_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))) return 'responses';
    if (ANTHROPIC_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))) return 'messages';
    return 'chat';
}

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
    return openCodeGoWireApi(model) === 'messages';
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
    const wire = openCodeGoWireApi(model);
    if (wire === 'messages') return `${bases.anthropic}/v1/messages`;
    if (wire === 'responses') return `${bases.openai}/responses`;
    return `${bases.openai}/chat/completions`;
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
        const wire = openCodeGoWireApi(model);
        if (wire === 'responses') {
            // OpenAI-family brands on the gateway (Muse Spark, GPT, Grok)
            // only answer on /responses; the compat transport switches wire
            // shape per request via this flag.
            return this.openai.send(messages, model, tools, { ...(sendOpts || {}), compatWireApi: 'responses' });
        }
        if (wire === 'messages') {
            // The Anthropic-style Go endpoint reports cached read/write usage
            // and accepts the standard message shape. Preserve the caller's
            // cache strategy so the shared Anthropic live-tail marker advances
            // through tool loops instead of forcing every request fully cold.
            const result = await this.anthropic.send(messages, model, tools, sendOpts);
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
