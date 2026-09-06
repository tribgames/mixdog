import { normalizeAnthropicEffortInput } from './anthropic-effort.mjs';

export const EFFORT_CONFIGURATION_BETA = 'mid-conversation-output-config-2026-07-01';
const ANTHROPIC_MODELS = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5']);
const OPENAI_PROVIDERS = new Set(['openai', 'openai-oauth']);
const ANTHROPIC_PROVIDERS = new Set(['anthropic', 'anthropic-oauth']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const META_KEY = 'effortConfiguration';
const anthropicEffortBodies = new WeakSet();

export function markAnthropicEffortBody(body, projection) {
    if (projection?.mode === 'anthropic') anthropicEffortBodies.add(body);
    return body;
}

export function usesAnthropicEffortBody(body) {
    return anthropicEffortBodies.has(body);
}

export function cloneAnthropicEffortBody(body, overrides) {
    const cloned = { ...body, ...overrides };
    if (usesAnthropicEffortBody(body)) anthropicEffortBodies.add(cloned);
    return cloned;
}

function modelKey(model) {
    return String(model || '').trim().toLowerCase()
        .replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
}

// Explicit protocol capabilities, not a prediction about future model families.
export function effortConfigurationMode(provider, model, opts = {}) {
    const id = modelKey(model);
    if (opts.effortConfigurationEnabled === false || Number(opts.thinkingBudgetTokens) > 0) return null;
    if (OPENAI_PROVIDERS.has(provider) && id === 'gpt-6-astra') {
        const parameters = opts.modelParameters || {};
        const mode = opts.reasoning?.mode ?? parameters.reasoning_mode ?? parameters.mode ?? 'standard';
        if (mode !== 'standard' || opts.multiAgent === true || parameters.multi_agent === true) return null;
        return 'responses';
    }
    if (ANTHROPIC_PROVIDERS.has(provider) && ANTHROPIC_MODELS.has(id)
        && opts.disableBetaHeaders !== true
        && (!opts.baseURL || /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(opts.baseURL))) return 'anthropic';
    return null;
}

function normalizedEffort(provider, model, effort) {
    if (ANTHROPIC_PROVIDERS.has(provider)) return normalizeAnthropicEffortInput(effort, model) || null;
    const value = String(effort || 'medium').trim().toLowerCase();
    return value === 'ultra' ? 'max' : value;
}

function validSnapshot(value, provider, model, mode) {
    return value?.version === 1 && value.provider === provider && value.model === modelKey(model)
        && value.mode === mode && EFFORTS.has(value.initialEffort) && EFFORTS.has(value.effort);
}

export function prepareTurnEffortConfiguration(session, provider) {
    const config = provider?.config || {};
    const opts = { ...config, modelParameters: session.modelParameters || {} };
    const mode = effortConfigurationMode(session.provider, session.model, opts);
    const effort = normalizedEffort(session.provider, session.model, session.effort);
    if (!mode || !EFFORTS.has(effort)) return null;
    const first = (session.messages || []).find((message) => validSnapshot(
        message?.meta?.[META_KEY], session.provider, session.model, mode,
    ))?.meta?.[META_KEY];
    const snapshot = {
        version: 1, provider: session.provider, model: modelKey(session.model), mode,
        initialEffort: first?.initialEffort || effort, effort,
    };
    // Persist the start/current distinction; the turn receives its own value
    // snapshot so a UI edit cannot change an in-flight provider request.
    session.effortConfiguration = snapshot;
    return snapshot;
}

export function projectEffortConfiguration(messages, provider, model, opts = {}) {
    const mode = effortConfigurationMode(provider, model, opts);
    if (!mode) return null;
    const marked = (messages || []).filter((message) => message?.role === 'user'
        && validSnapshot(message?.meta?.[META_KEY], provider, model, mode));
    const seed = marked[0]?.meta?.[META_KEY] || opts.effortConfiguration;
    if (!validSnapshot(seed, provider, model, mode)) return null;
    const updates = new Map();
    let current = seed.initialEffort;
    for (const message of marked) {
        const value = message.meta[META_KEY];
        if (value.effort !== current) {
            updates.set(message, value.effort);
            current = value.effort;
        }
    }
    if (!marked.length && seed.effort !== current) {
        const nextUser = messages.findLast((message) => message?.role === 'user');
        if (nextUser) {
            updates.set(nextUser, seed.effort);
            current = seed.effort;
        }
    }
    return { mode, initialEffort: seed.initialEffort, effort: current, updates };
}

// Split only at real user-turn boundaries. Sanitizing each segment before
// inserting the trusted empty system control avoids losing it as empty text,
// and never separates a tool call from its result.
export function lowerAnthropicEffortHistory(messages, lower, projection) {
    if (!projection) return lower(messages);
    // Cache markers otherwise turn a string into a text-block array only on
    // some turns. Keep one representation throughout a configured history.
    const canonical = (items) => items.map((message) => typeof message.content === 'string'
        ? { ...message, content: [{ type: 'text', text: message.content }] }
        : message);
    if (!projection.updates.size) return canonical(lower(messages));
    const result = [];
    let segment = [];
    for (const message of messages) {
        const effort = projection.updates.get(message);
        if (effort) {
            if (segment.length) result.push(...lower(segment));
            result.push({ role: 'system', content: [], output_config: { effort } });
            segment = [];
        }
        segment.push(message);
    }
    if (segment.length) result.push(...lower(segment));
    return canonical(result);
}

export function stripEffortConfiguration(messages) {
    return messages.map((message) => {
        if (!message?.meta || !Object.hasOwn(message.meta, META_KEY)) return message;
        const { [META_KEY]: _drop, ...meta } = message.meta;
        return { ...message, meta };
    });
}

export function rebaseCompactedEffortConfiguration(before, after) {
    const last = before.findLast((message) => {
        const value = message?.meta?.[META_KEY];
        return value && validSnapshot(value, value.provider, value.model, value.mode);
    })?.meta?.[META_KEY];
    if (!last) return after;
    const result = stripEffortConfiguration(after);
    const index = result.findIndex((message) => message?.role === 'user');
    if (index >= 0) result[index] = {
        ...result[index],
        meta: { ...result[index].meta, [META_KEY]: { ...last, initialEffort: last.effort } },
    };
    return result;
}
