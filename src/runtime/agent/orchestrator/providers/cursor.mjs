import { randomUUID } from 'node:crypto';
import { getAgentApiKey } from '../../../shared/config.mjs';
import {
    knownToolNamesFromOpenAITools,
    parseToolCalls,
    toOpenAIMessages,
    toOpenAITools,
} from './openai-compat-wire.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { ensureChatToolPairs } from './lib/wire-pairing.mjs';
import {
    cursorTokenExpiry,
    exchangeCursorToken,
    resolveCursorOAuthAccessToken,
} from './cursor-auth.mjs';

let runtimePromise = null;
const CURSOR_EFFORT_ORDER = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const CURSOR_DEFAULT_EFFORT_ORDER = Object.freeze([null, 'medium', 'high', 'low', 'none', 'xhigh', 'max']);
const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;

async function loadCursorRuntime() {
    if (!runtimePromise) {
        runtimePromise = import('./cursor-wire.mjs');
    }
    return runtimePromise;
}

function toCursorMessages(messages, providerName) {
    const output = [];
    for (const message of messages || []) {
        const converted = toOpenAIMessages([message], providerName);
        if (message?.role !== 'tool') {
            output.push(...converted);
            continue;
        }
        const toolMessage = converted.find((entry) => entry.role === 'tool');
        if (!toolMessage) continue;
        const media = converted
            .filter((entry) => entry.role === 'user' && Array.isArray(entry.content))
            .flatMap((entry) => entry.content);
        output.push({
            ...toolMessage,
            mixdog_tool_error: message.toolKind === 'error' || message.isError === true,
            ...(media.length ? { mixdog_tool_media: media } : {}),
        });
    }
    return output;
}

function toCursorToolChoice(toolChoice) {
    if (typeof toolChoice === 'string') return toolChoice;
    if (!toolChoice || typeof toolChoice !== 'object') return undefined;
    const name = toolChoice.name || toolChoice.function?.name;
    return typeof name === 'string' && name
        ? { type: 'function', function: { name } }
        : undefined;
}

async function responseError(response, label) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.message || text;
    } catch { /* plain text */ }
    const error = new Error(`${label} request failed (${response.status})${message ? `: ${message}` : ''}`);
    error.status = response.status;
    throw error;
}

async function* responseSseEvents(response, signal) {
    if (!response?.ok) await responseError(response, 'Cursor');
    if (!response.body) throw new Error('Cursor response body is empty');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        void reader.cancel(signal?.reason).catch(() => {});
    };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        while (!aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || '';
            for (const block of blocks) {
                for (const line of block.split(/\r?\n/)) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    yield JSON.parse(data);
                }
            }
        }
        if (aborted) throw signal?.reason instanceof Error ? signal.reason : new Error('Cursor request aborted');
    } finally {
        if (signal) {
            try { signal.removeEventListener('abort', onAbort); } catch {}
        }
        if (aborted) await reader.cancel().catch(() => {});
    }
}

function parseCursorVariantId(value) {
    const originalId = String(value || '').trim();
    if (originalId === 'auto' || originalId === 'default') {
        return { id: originalId, baseId: 'auto', effort: null, fast: false, thinking: false };
    }
    let id = originalId;
    let fast = false;
    let thinking = false;
    let effort = null;
    if (id.endsWith('-fast')) {
        fast = true;
        id = id.slice(0, -5);
    }
    if (id.endsWith('-thinking')) {
        thinking = true;
        id = id.slice(0, -9);
    }
    if (id.endsWith('-extra-high')) {
        effort = 'xhigh';
        id = id.slice(0, -11);
    } else {
        const match = id.match(/-(none|low|medium|high|xhigh|max)$/);
        if (match) {
            effort = match[1];
            id = id.slice(0, -match[0].length);
        }
    }
    if (id.endsWith('-thinking')) {
        thinking = true;
        id = id.slice(0, -9);
    }
    return {
        id: originalId,
        baseId: `${id}${thinking ? '-thinking' : ''}`,
        effort,
        fast,
        thinking,
    };
}

function cursorVariantDisplay(entry, variant) {
    if (variant.baseId === 'auto') return 'Auto';
    let display = String(entry?.name || entry?.display || entry?.id || variant.baseId).trim();
    display = display.replace(/\s+Fast$/i, '');
    if (variant.effort) {
        const label = variant.effort === 'xhigh'
            ? 'Extra High'
            : variant.effort.charAt(0).toUpperCase() + variant.effort.slice(1);
        display = display.replace(new RegExp(`\\s+${label}(?=\\s+Thinking(?:\\s|$)|\\s+\\(NO ZDR\\)|$)`, 'i'), '');
    }
    return display || variant.baseId;
}

function variantPreference(variant) {
    const effortRank = CURSOR_DEFAULT_EFFORT_ORDER.indexOf(variant.effort);
    return (variant.fast ? 100 : 0) + (effortRank < 0 ? 50 : effortRank);
}

function isCursorEffortParameterId(id) {
    const key = String(id || '').trim().toLowerCase();
    return key === 'effort' || key === 'reasoning' || key.endsWith('_effort') || key.endsWith('-effort');
}

function normalizeCursorParameterValue(id, value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (isCursorEffortParameterId(id)) {
        return text === 'extra-high' ? 'xhigh' : text;
    }
    return text;
}

function cursorContextWindow(value) {
    const match = String(value || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!match) return 0;
    const scale = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
    return Math.round(Number(match[1]) * scale);
}

function cursorPlainText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, ' · ')
        .replace(/<[^>]+>/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_`]+/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s*·\s*/g, ' · ')
        .replace(/(?:\s*·\s*){2,}/g, ' · ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cursorDescriptionContextWindow(value) {
    const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*([km])\s+context window/i);
    return match ? cursorContextWindow(`${match[1]}${match[2]}`) : 0;
}

function cursorModelDescription(entry) {
    const display = cursorPlainText(entry?.name || entry?.id);
    const parts = cursorPlainText(entry?.description).split(' · ').filter(Boolean);
    if (parts.length && display) {
        const heading = parts[0].replace(/\s+\([^)]*\)\s*$/, '').trim();
        if (heading.toLowerCase() === display.toLowerCase()) parts.shift();
    }
    return parts.join(' · ');
}

function parameterizedCursorModel(entry, provider) {
    const definitions = Array.isArray(entry.parameterDefinitions) ? entry.parameterDefinitions : [];
    const effortDefinition = definitions.find((definition) => isCursorEffortParameterId(definition.id));
    const normalizedVariants = (entry.variants || []).map((variant) => ({
        ...variant,
        routeParameters: Object.fromEntries(Object.entries(variant.parameters || {}).map(([id, value]) => [
            id === effortDefinition?.id ? 'effort' : id,
            normalizeCursorParameterValue(id, value),
        ])),
    }));
    const supportsMaxMode = entry.supportsMaxMode === true;
    const supportsNonMaxMode = entry.supportsNonMaxMode === true || !supportsMaxMode;
    const maxOnly = supportsMaxMode && !supportsNonMaxMode;
    const defaultVariant = normalizedVariants.find((variant) => (
        maxOnly ? variant.defaultMax === true : variant.defaultNonMax === true
    )) || normalizedVariants.find((variant) => variant.maxMode === maxOnly) || normalizedVariants[0] || null;
    const efforts = effortDefinition
        ? effortDefinition.values.map((option) => normalizeCursorParameterValue(effortDefinition.id, option.value))
        : [];
    const fastEfforts = [...new Set(normalizedVariants
        .filter((variant) => variant.routeParameters.fast === 'true')
        .map((variant) => variant.routeParameters.effort || ''))];
    const modelParameterOptions = definitions
        .filter((definition) => !isCursorEffortParameterId(definition.id) && definition.id !== 'fast')
        .map((definition) => ({
            id: definition.id,
            label: definition.name || definition.id,
            kind: definition.kind,
            options: definition.values.map((option) => ({
                value: normalizeCursorParameterValue(definition.id, option.value),
                label: option.label,
                ...(definition.id === 'context' && cursorContextWindow(option.value)
                    ? { contextWindow: cursorContextWindow(option.value) }
                    : {}),
            })),
        }));
    const defaultModelParameters = Object.fromEntries(Object.entries(defaultVariant?.routeParameters || {})
        .filter(([id]) => !['effort', 'fast'].includes(id)));
    const description = cursorModelDescription(entry);
    const describedContextWindow = cursorDescriptionContextWindow(description);
    const nonMaxContextWindow = cursorContextWindow(defaultModelParameters.context)
        || Number(entry.contextWindow)
        || (supportsMaxMode && supportsNonMaxMode ? 0 : describedContextWindow)
        || CURSOR_DEFAULT_CONTEXT_WINDOW;
    const maxContextWindow = Number(entry.maxContextWindow)
        || (supportsMaxMode ? describedContextWindow : 0);
    const contextWindow = maxOnly
        ? (maxContextWindow || nonMaxContextWindow)
        : nonMaxContextWindow;
    return {
        id: entry.id,
        display: cursorPlainText(entry.name || entry.id),
        provider,
        mode: 'chat',
        contextWindow,
        ...(maxContextWindow > contextWindow ? { maxContextWindow } : {}),
        description,
        supportsVision: entry.supportsVision === true,
        reasoning: efforts.length > 0 || entry.supportsReasoning === true,
        supportsReasoning: efforts.length > 0 || entry.supportsReasoning === true,
        reasoningLevels: efforts,
        reasoningOptions: efforts.length ? [{ type: 'effort', values: efforts }] : [],
        fastCapable: definitions.some((definition) => definition.id === 'fast'),
        fastEfforts,
        modelParameterOptions,
        parameterVariants: normalizedVariants.map((variant) => variant.routeParameters),
        defaultModelParameters,
        defaultEffort: defaultVariant?.routeParameters?.effort || null,
        defaultFast: defaultVariant?.routeParameters?.fast === 'true',
        supportsMaxMode,
        _cursorParameterized: {
            id: entry.id,
            definitions,
            effortParameterId: effortDefinition?.id || null,
            variants: normalizedVariants,
            contextWindow,
            maxContextWindow: maxContextWindow || contextWindow,
            supportsMaxMode,
            supportsNonMaxMode,
        },
    };
}

function normalizeCursorCatalog(entries, provider) {
    const groups = new Map();
    const rawIds = new Set();
    const aliases = new Map();
    const parameterGroups = new Map();
    const parameterizedModels = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        if ((Array.isArray(entry?.parameterDefinitions) && entry.parameterDefinitions.length)
            || entry?.supportsMaxMode === true
            || entry?.supportsNonMaxMode === true
            || Number(entry?.maxContextWindow) > 0) {
            const model = parameterizedCursorModel(entry, provider);
            parameterizedModels.push(model);
            parameterGroups.set(model.id, model._cursorParameterized);
            delete model._cursorParameterized;
            rawIds.add(model.id);
            for (const alias of entry.aliases || []) {
                const variant = (entry.variants || []).find((candidate) => candidate.legacySlug === alias);
                if (!aliases.has(alias)) {
                    aliases.set(alias, {
                        baseId: model.id,
                        parameters: variant?.parameters || {},
                        alias: true,
                    });
                }
                rawIds.add(alias);
            }
            continue;
        }
        const variant = { ...parseCursorVariantId(entry?.id), entry };
        if (!variant.id) continue;
        rawIds.add(variant.id);
        if (!groups.has(variant.baseId)) groups.set(variant.baseId, []);
        groups.get(variant.baseId).push(variant);
    }
    if (!groups.has('auto') && !parameterGroups.has('auto')) {
        groups.set('auto', [{
            ...parseCursorVariantId('default'),
            entry: { id: 'default', name: 'Auto', contextWindow: 200_000, maxTokens: 64_000 },
        }]);
        rawIds.add('default');
    }
    const models = [...parameterizedModels];
    for (const [baseId, variants] of groups) {
        variants.sort((a, b) => variantPreference(a) - variantPreference(b) || a.id.localeCompare(b.id));
        const representative = variants[0];
        const efforts = CURSOR_EFFORT_ORDER.filter((effort) => variants.some((variant) => variant.effort === effort));
        const fastEfforts = [...new Set(
            variants.filter((variant) => variant.fast).map((variant) => variant.effort || ''),
        )];
        const supportsReasoning = efforts.length > 0 || representative.thinking;
        models.push({
            id: baseId,
            display: cursorVariantDisplay(representative.entry, representative),
            provider,
            mode: 'chat',
            contextWindow: Number(representative.entry?.contextWindow) || 200_000,
            ...(Number(representative.entry?.maxTokens) ? { outputTokens: Number(representative.entry.maxTokens) } : {}),
            reasoning: supportsReasoning,
            supportsReasoning,
            reasoningLevels: efforts,
            reasoningOptions: efforts.length ? [{ type: 'effort', values: efforts }] : [],
            fastCapable: fastEfforts.length > 0,
            fastEfforts,
        });
    }
    return { models, groups, rawIds, aliases, parameterGroups };
}

function selectParameterizedCursorVariant(group, requested, sendOpts = {}) {
    const aliasParameters = requested?.parameters || {};
    const maxMode = group.supportsMaxMode === true
        && (group.supportsNonMaxMode !== true
            || Number(sendOpts.selectedContextWindow) > Number(group.contextWindow || 0));
    const modeVariants = group.variants.filter((variant) => variant.maxMode === maxMode);
    const availableVariants = modeVariants.length ? modeVariants : group.variants;
    const defaultVariant = availableVariants.find((variant) => (
        maxMode ? variant.defaultMax === true : variant.defaultNonMax === true
    )) || availableVariants[0] || null;
    const parameters = { ...(defaultVariant?.parameters || {}), ...aliasParameters };
    const routeParameters = sendOpts.modelParameters && typeof sendOpts.modelParameters === 'object'
        ? sendOpts.modelParameters
        : {};
    for (const definition of group.definitions) {
        if (Object.prototype.hasOwnProperty.call(routeParameters, definition.id)) {
            parameters[definition.id] = String(routeParameters[definition.id]);
        }
    }
    if (group.effortParameterId && sendOpts.effort) {
        const wanted = normalizeCursorParameterValue(group.effortParameterId, sendOpts.effort);
        const option = group.definitions.find((definition) => definition.id === group.effortParameterId)
            ?.values.find((candidate) => normalizeCursorParameterValue(group.effortParameterId, candidate.value) === wanted);
        if (!option) throw new Error(`Cursor model ${group.id} does not offer ${wanted} effort`);
        parameters[group.effortParameterId] = option.value;
    }
    if (group.definitions.some((definition) => definition.id === 'fast')
        && (requested?.alias !== true || sendOpts.fast === true)) {
        parameters.fast = sendOpts.fast === true ? 'true' : 'false';
    }
    const selected = availableVariants.find((variant) => Object.entries(parameters)
        .every(([id, value]) => String(variant.parameters?.[id] ?? '') === String(value)));
    if (!selected && availableVariants.length) {
        throw new Error(`Cursor model ${group.id} does not offer the selected parameter combination`);
    }
    return {
        modelId: group.id,
        parameters: Object.entries(parameters).map(([id, value]) => ({ id, value: String(value) })),
        maxMode,
    };
}

function selectCursorVariant(group, { effort = null, fast = false } = {}) {
    if (!Array.isArray(group) || group.length === 0) return null;
    const normalizedEffort = String(effort || '').trim().toLowerCase() || null;
    if (normalizedEffort) {
        const exact = group.find((variant) => variant.effort === normalizedEffort && variant.fast === fast);
        if (exact) return exact;
        const effortExists = group.some((variant) => variant.effort === normalizedEffort);
        if (fast && effortExists) {
            throw new Error(`Cursor model ${group[0].baseId} does not offer ${normalizedEffort} effort in Fast mode`);
        }
        throw new Error(`Cursor model ${group[0].baseId} does not offer ${normalizedEffort} effort`);
    }
    const sameSpeed = group.filter((variant) => variant.fast === fast);
    for (const preferred of CURSOR_DEFAULT_EFFORT_ORDER) {
        const match = sameSpeed.find((variant) => variant.effort === preferred);
        if (match) return match;
    }
    return sameSpeed[0] || null;
}

class CursorProviderBase {
    static inputExcludesCache = false;
    name;
    config;
    _runtimeOverride;
    _cursorCatalog = null;

    constructor(name, config = {}) {
        this.name = name;
        this.config = config || {};
        this._runtimeOverride = this.config.runtime || null;
    }

    async _runtime() {
        return this._runtimeOverride || loadCursorRuntime();
    }

    async _accessToken() {
        throw new Error('Cursor access-token resolver not implemented');
    }

    async _loadCursorCatalog(runtime, accessToken) {
        if (this._cursorCatalog) return this._cursorCatalog;
        const raw = await runtime.getCursorModels(accessToken);
        this._cursorCatalog = normalizeCursorCatalog(raw, this.name);
        return this._cursorCatalog;
    }

    getCachedModelInfo(model) {
        return this._cursorCatalog?.models?.find((entry) => entry.id === model) || null;
    }

    async _resolveCursorModel(model, sendOpts, runtime, accessToken) {
        const requested = String(model || 'auto').trim() || 'auto';
        const catalog = await this._loadCursorCatalog(runtime, accessToken);
        const alias = catalog.aliases.get(requested);
        const parameterGroup = catalog.parameterGroups.get(requested);
        if (parameterGroup) {
            return selectParameterizedCursorVariant(parameterGroup, { baseId: requested }, sendOpts);
        }
        // Existing legacy/alternate ids remain exact pass-through routes. Some
        // aliases intentionally represent a different context default than
        // the parameterized base, so folding them would silently change a
        // persisted route.
        if (alias) return { modelId: requested, parameters: [] };
        const parsed = parseCursorVariantId(requested);
        const group = catalog.groups.get(parsed.baseId);
        if (!group) return { modelId: requested, parameters: [] };
        const isCanonical = requested === parsed.baseId || requested === 'auto';
        if (catalog.rawIds.has(requested) && !isCanonical && !sendOpts.effort && sendOpts.fast !== true) {
            return { modelId: requested, parameters: [] };
        }
        const selected = selectCursorVariant(group, {
            effort: sendOpts.effort || (isCanonical ? null : parsed.effort),
            fast: sendOpts.fast === true,
        });
        return { modelId: selected?.id || requested, parameters: [] };
    }

    async send(messages, model, tools, sendOpts = {}) {
        const signal = sendOpts.signal || null;
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Cursor request aborted');
        const runtime = await this._runtime();
        let accessToken = await this._accessToken({ signal });
        let cursorSelection = await this._resolveCursorModel(model, sendOpts, runtime, accessToken);
        const sessionScope = String(
            sendOpts.sessionId
            || sendOpts.providerCacheKey
            || sendOpts.promptCacheKey
            || `cursor-call:${randomUUID()}`,
        );
        const openAiTools = tools?.length ? toOpenAITools(tools) : undefined;
        const dispatch = async () => {
            let liveTextEmitted = false;
            let emittedToolCall = false;
            const body = {
                model: cursorSelection.modelId,
                mixdog_model_parameters: cursorSelection.parameters,
                mixdog_max_mode: cursorSelection.maxMode === true,
                // Wire-level pairing guard: a call whose result never committed
                // (cancel/abort) is hard-rejected unpaired, so synthesize the
                // missing tool messages on the assembled array.
                messages: ensureChatToolPairs(toCursorMessages(messages, this.name)),
                mixdog_session_id: sessionScope,
                stream: true,
                stream_options: { include_usage: true },
                ...(openAiTools ? { tools: openAiTools } : {}),
                ...(toCursorToolChoice(sendOpts.toolChoice) !== undefined
                    ? { tool_choice: toCursorToolChoice(sendOpts.toolChoice) }
                    : {}),
            };
            try { sendOpts.onStageChange?.('requesting'); } catch {}
            try {
                const response = await runtime.handleChatCompletion(body, accessToken);
                try { sendOpts.onStageChange?.('streaming'); } catch {}
                return await consumeCompatChatCompletionStream(responseSseEvents(response, signal), {
                    signal,
                    label: this.name,
                    onStreamDelta: (delta) => {
                        sendOpts.onStreamDelta?.(delta);
                    },
                    onToolCall: (call) => {
                        emittedToolCall = true;
                        sendOpts.onToolCall?.(call);
                    },
                    onTextDelta: (text) => {
                        if (text) liveTextEmitted = true;
                        sendOpts.onTextDelta?.(text);
                    },
                    parseToolCalls,
                    knownToolNames: knownToolNamesFromOpenAITools(openAiTools),
                });
            } catch (error) {
                if (liveTextEmitted) error.liveTextEmitted = true;
                if (emittedToolCall) error.emittedToolCall = true;
                if (liveTextEmitted || emittedToolCall) error.unsafeToRetry = true;
                throw error;
            }
        };
        let assembled;
        try {
            assembled = await dispatch();
        } catch (error) {
            const status = Number(error?.httpStatus || error?.status || 0);
            const safe = error?.unsafeToRetry !== true && !signal?.aborted;
            if (safe && (status === 401 || status === 403)) {
                const refreshed = await this._accessToken({ signal, forceRefresh: true });
                if (refreshed && refreshed !== accessToken) {
                    accessToken = refreshed;
                    assembled = await dispatch();
                } else {
                    throw error;
                }
            } else if (safe && status === 404) {
                const previousModel = JSON.stringify(cursorSelection);
                await this._refreshModelCache();
                cursorSelection = await this._resolveCursorModel(model, sendOpts, runtime, accessToken);
                if (JSON.stringify(cursorSelection) !== previousModel) assembled = await dispatch();
                else throw error;
            } else {
                throw error;
            }
        }
        const rawUsage = assembled.rawUsage;
        return {
            content: assembled.content || '',
            model: model || assembled.model || 'auto',
            toolCalls: assembled.toolCalls,
            stopReason: assembled.stopReason,
            ...(assembled.reasoningContent ? { reasoningContent: assembled.reasoningContent } : {}),
            usage: rawUsage ? {
                inputTokens: Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0),
                outputTokens: Number(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0),
                cachedTokens: Number(rawUsage.cached_tokens ?? 0),
                promptTokens: Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0),
                raw: { ...rawUsage },
            } : undefined,
        };
    }

    async listModels() {
        const runtime = await this._runtime();
        const accessToken = await this._accessToken({});
        return (await this._loadCursorCatalog(runtime, accessToken)).models;
    }

    async getUsageSnapshot() {
        const runtime = await this._runtime();
        const accessToken = await this._accessToken({});
        const snapshot = await runtime.getCursorUsage(accessToken);
        return {
            ...snapshot,
            provider: this.name,
        };
    }

    async _refreshModelCache() {
        const runtime = await this._runtime();
        runtime.clearModelCache?.();
        this._cursorCatalog = null;
        return this.listModels();
    }
}

export class CursorApiProvider extends CursorProviderBase {
    _cachedAccess = null;

    constructor(config = {}) {
        super('cursor-api', config);
    }

    async _accessToken({ signal, forceRefresh = false } = {}) {
        if (this.config.accessToken) return this.config.accessToken;
        if (forceRefresh) this._cachedAccess = null;
        if (this._cachedAccess?.token && this._cachedAccess.expiresAt > Date.now() + 5 * 60_000) {
            return this._cachedAccess.token;
        }
        const apiKey = this.config.apiKey || getAgentApiKey('cursor-api');
        if (!apiKey) throw new Error('Cursor API key is not configured. Open /providers in Mixdog.');
        try {
            const exchanged = await (this.config.exchangeFn || exchangeCursorToken)(apiKey, {
                fetchFn: this.config.fetchFn || fetch,
                signal,
            });
            this._cachedAccess = {
                token: exchanged.access_token,
                expiresAt: exchanged.expires_at || Date.now() + 60 * 60_000,
            };
            return this._cachedAccess.token;
        } catch (error) {
            if (cursorTokenExpiry(apiKey) > Date.now()) return apiKey;
            throw error;
        }
    }
}

export class CursorOAuthProvider extends CursorProviderBase {
    constructor(config = {}) {
        super('cursor-oauth', config);
    }

    async _accessToken({ signal, forceRefresh = false } = {}) {
        if (this.config.accessToken) return this.config.accessToken;
        return resolveCursorOAuthAccessToken({
            forceRefresh,
            fetchFn: this.config.fetchFn || fetch,
            signal,
        });
    }
}

export const __cursorModelInternals = Object.freeze({
    normalizeCursorCatalog,
    parseCursorVariantId,
    selectCursorVariant,
    selectParameterizedCursorVariant,
    toCursorMessages,
    toCursorToolChoice,
});
