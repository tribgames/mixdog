import { providerNativeToolPrefixCount } from '../../../../../session-runtime/provider-request-tools.mjs';

export const ANTHROPIC_CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };
export const ANTHROPIC_CACHE_TTL_VOLATILE = { type: 'ephemeral' };

export function appendAnthropicCacheControl(content, ttl = ANTHROPIC_CACHE_TTL_VOLATILE) {
    const withCacheControl = (block) => {
        if (!block || typeof block !== 'object' || block.cache_control) return block;
        return { ...block, cache_control: ttl };
    };
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1]);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content })];
    }
    return content;
}

export function resolveAnthropicCacheTtls(opts) {
    const strategy = opts?.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const value = strategy[layer];
        if (value === '1h') return ANTHROPIC_CACHE_TTL_STABLE;
        if (value === '5m') return ANTHROPIC_CACHE_TTL_VOLATILE;
        if (value === 'none') return null;
        return fallback;
    };
    const resolved = {
        tools: pick('tools', null),
        system: pick('system', ANTHROPIC_CACHE_TTL_STABLE),
        tier3: pick('tier3', ANTHROPIC_CACHE_TTL_STABLE),
        messages: pick('messages', ANTHROPIC_CACHE_TTL_STABLE),
    };
    const ttlRank = (ttl) => (ttl === ANTHROPIC_CACHE_TTL_STABLE ? 2 : 1);
    let minRank = Infinity;
    for (const layer of ['system', 'tier3', 'messages']) {
        if (!resolved[layer]) continue;
        const rank = ttlRank(resolved[layer]);
        if (rank > minRank) resolved[layer] = ANTHROPIC_CACHE_TTL_VOLATILE;
        else minRank = rank;
    }
    return resolved;
}

export function clampAnthropicThinkingBudget(value, maxTokens) {
    const desired = Math.floor(Number(value));
    const max = Math.floor(Number(maxTokens));
    if (!Number.isFinite(desired) || desired <= 0 || !Number.isFinite(max)) return null;
    const ceiling = max - 1024;
    if (ceiling < 1024) return null;
    return Math.max(1024, Math.min(desired, ceiling));
}

export function sanitizeAnthropicInputSchema(schema, toolName, logTag) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    const compound = schema.oneOf || schema.anyOf || schema.allOf;
    if (!compound) return structuredClone(schema);
    const mergedProps = { ...(schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) };
    const branchDescs = [];
    for (const branch of Array.isArray(compound) ? compound : []) {
        if (branch && typeof branch === 'object' && branch.properties) {
            Object.assign(mergedProps, branch.properties);
        }
        if (branch && typeof branch === 'object') {
            const parts = [];
            if (branch.description) parts.push(branch.description);
            else if (branch.type) parts.push(`type:${branch.type}`);
            if (parts.length) branchDescs.push(parts.join(' '));
        }
    }
    const compoundKey = schema.oneOf ? 'oneOf' : schema.anyOf ? 'anyOf' : 'allOf';
    let description = schema.description || '';
    if (branchDescs.length) {
        const parts = [];
        let used = 0;
        for (let i = 0; i < branchDescs.length; i++) {
            const value = `(variant ${i + 1}: ${branchDescs[i]})`;
            if (used + value.length + (parts.length ? 1 : 0) > 500) break;
            parts.push(value);
            used += value.length + (parts.length > 1 ? 1 : 0);
        }
        const addition = parts.join(' ');
        if (addition) description = description ? `${description} ${addition}` : addition;
    }
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(
            `[${logTag}-sanitizer] tool="${toolName ?? ''}" compound="${compoundKey}" branches=${Array.isArray(compound) ? compound.length : 0} mergedProps=${Object.keys(mergedProps).length}\n`
        );
    }
    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: mergedProps,
    };
}

function toAnthropicTools(tools, logTag) {
    return tools.map((tool) => {
        const out = {
            name: tool.name,
            description: tool.description,
            input_schema: sanitizeAnthropicInputSchema(tool.inputSchema, tool.name, logTag),
        };
        if (tool.deferLoading === true || tool.defer_loading === true) out.defer_loading = true;
        return out;
    });
}

export function toAnthropicToolChoice(toolChoice) {
    return toolChoice === 'none' ? { type: 'none' } : undefined;
}

export function deferredAnthropicTools(activeTools, messages, opts, provider) {
    if (opts?.session?.deferredNativeTools !== true) return [];
    if (!Array.isArray(activeTools) || activeTools.length === 0) return [];
    const active = new Set(activeTools.map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const anthropicNative = new Set(['anthropic', 'anthropic-oauth']);
    const discovered = new Set(
        Array.isArray(opts?.session?.deferredDiscoveredTools)
            ? opts.session.deferredDiscoveredTools.map((name) => String(name || '').trim()).filter(Boolean)
            : [],
    );
    for (const message of Array.isArray(messages) ? messages : []) {
        const native = message?.nativeToolSearch;
        const source = String(native?.provider || '').toLowerCase();
        if (source && source !== provider
            && !(anthropicNative.has(source) && anthropicNative.has(provider))) continue;
        for (const name of Array.isArray(native?.toolReferences) ? native.toolReferences : []) {
            const key = String(name || '').trim();
            if (key) discovered.add(key);
        }
    }
    const catalog = Array.isArray(opts.session.deferredToolCatalog) ? opts.session.deferredToolCatalog : [];
    return catalog
        .filter((tool) => tool?.name && discovered.has(String(tool.name)) && !active.has(String(tool.name)))
        .map((tool) => ({ ...tool, deferLoading: true }));
}

export function requestAnthropicTools(tools, messages, opts, provider) {
    const activeTools = Array.isArray(tools) ? tools : [];
    if (opts?.providerToolSnapshotAuthoritative === true) {
        const nativePrefixCount = providerNativeToolPrefixCount(
            activeTools,
            opts.providerNativeToolPrefixCount,
        );
        return [
            ...activeTools.slice(0, nativePrefixCount),
            ...toAnthropicTools(activeTools.slice(nativePrefixCount), provider),
        ];
    }
    const deferredTools = deferredAnthropicTools(activeTools, messages, opts, provider);
    const nativeTools = Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter((tool) => tool && typeof tool === 'object')
        : [];
    return [
        ...nativeTools,
        ...toAnthropicTools([...activeTools, ...deferredTools], provider),
    ];
}

export function applyAnthropicCacheMarkers(sanitizedMessages, {
    messageTtl = ANTHROPIC_CACHE_TTL_VOLATILE,
    messageSlots = 1,
} = {}) {
    if (!Array.isArray(sanitizedMessages) || sanitizedMessages.length === 0) {
        return sanitizedMessages;
    }
    const firstText = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const first = content.find((block) => block?.type === 'text');
            return first && typeof first.text === 'string' ? first.text : '';
        }
        return '';
    };
    const isSystemReminder = (content) => firstText(content).startsWith('<system-reminder>');
    const hasUserText = (message) => {
        if (message?.role !== 'user' || isSystemReminder(message.content)) return false;
        if (typeof message.content === 'string') return message.content.trim().length > 0;
        if (!Array.isArray(message.content)) return false;
        return message.content.some((block) => block?.type === 'text'
            && typeof block.text === 'string' && block.text.trim().length > 0);
    };
    const previousUserTextAnchorIdx = () => {
        for (let i = sanitizedMessages.length - 2; i >= 0; i--) {
            if (hasUserText(sanitizedMessages[i])) return i;
        }
        return -1;
    };
    const latestToolResultTailIdx = () => {
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const message = sanitizedMessages[i];
            if (message?.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) continue;
            if (message.content[message.content.length - 1]?.type === 'tool_result') return i;
        }
        return -1;
    };
    const firstRequestUserPromptIdx = () => {
        if (latestToolResultTailIdx() !== -1 || previousUserTextAnchorIdx() !== -1) return -1;
        const tailIdx = sanitizedMessages.length - 1;
        return hasUserText(sanitizedMessages[tailIdx]) ? tailIdx : -1;
    };
    if (messageTtl !== null) {
        const slots = Math.max(0, Math.min(4, Number(messageSlots) || 0));
        const marked = new Set();
        const candidates = [latestToolResultTailIdx(), previousUserTextAnchorIdx(), firstRequestUserPromptIdx()];
        for (const idx of candidates) {
            if (slots <= 0) break;
            if (idx < 0 || marked.has(idx)) continue;
            const message = sanitizedMessages[idx];
            if (messageTtl?.ttl === '1h' && isSystemReminder(message?.content)) continue;
            message.content = appendAnthropicCacheControl(message.content, messageTtl);
            marked.add(idx);
            if (marked.size >= slots) break;
        }
    }
    return sanitizedMessages;
}
