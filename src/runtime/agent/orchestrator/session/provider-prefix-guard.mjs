import { createHash } from 'crypto';

const COMPACTION_INTENTS = new Set([
    'automatic_compaction',
    'deferred_body_compaction',
    'manual_compaction',
    'post_turn_compaction',
]);

function digest(value) {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') {
        throw new TypeError('provider prefix value is not serializable');
    }
    return createHash('sha256').update(encoded).digest('hex');
}

function cacheRelevantRequestPrefix(requestPrefix, provider) {
    const prefix = requestPrefix && typeof requestPrefix === 'object'
        ? requestPrefix
        : {};
    const anthropic = /^(?:anthropic|anthropic-oauth)$/i.test(String(provider || ''));
    const cacheRelevantTools = (tools) => (
        Array.isArray(tools)
            ? tools.filter((tool) => !anthropic
                || (tool?.deferLoading !== true && tool?.defer_loading !== true))
            : []
    );
    return {
        ...prefix,
        tools: cacheRelevantTools(prefix.tools),
        nativeTools: cacheRelevantTools(prefix.nativeTools),
    };
}

function snapshot(messages, requestPrefix, options = {}) {
    const provider = String(options.provider || '');
    const model = String(options.model || '');
    const relevantPrefix = cacheRelevantRequestPrefix(requestPrefix, provider);
    return {
        messageHashes: messages.map(digest),
        requestPrefixHash: digest({ provider, model, requestPrefix: relevantPrefix }),
        provider,
        model,
        toolSchemaHash: digest(relevantPrefix.tools),
        nativeToolSchemaHash: digest(relevantPrefix.nativeTools),
    };
}

function firstChangedMessageIndex(previousHashes, nextHashes) {
    const limit = Math.min(previousHashes.length, nextHashes.length);
    for (let index = 0; index < limit; index += 1) {
        if (previousHashes[index] !== nextHashes[index]) return index;
    }
    return nextHashes.length < previousHashes.length ? nextHashes.length : null;
}

function notifyCacheBreak(options, details) {
    try { options.onCacheBreak?.(details); } catch { /* observability only */ }
}

function requestPrefixChangeReason(previous, next) {
    if (previous.provider !== undefined && previous.provider !== next.provider) return 'provider_changed';
    if (previous.model !== undefined && previous.model !== next.model) return 'model_changed';
    if (previous.toolSchemaHash !== undefined && previous.toolSchemaHash !== next.toolSchemaHash) {
        return 'tool_schema_changed';
    }
    if (previous.nativeToolSchemaHash !== undefined
        && previous.nativeToolSchemaHash !== next.nativeToolSchemaHash) {
        return 'native_tool_schema_changed';
    }
    return 'request_properties_changed';
}

export class ProviderPrefixMutationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ProviderPrefixMutationError';
        this.code = 'PROVIDER_PREFIX_MUTATION';
        this.details = details;
    }
}

export function isCompactionPrefixReset(intent) {
    return COMPACTION_INTENTS.has(String(intent || ''));
}

export function prepareProviderPrefixGuard(previous, messages, requestPrefix, options = {}) {
    const next = snapshot(Array.isArray(messages) ? messages : [], requestPrefix, options);
    if (!previous) return next;

    const previousHashes = Array.isArray(previous.messageHashes) ? previous.messageHashes : [];
    const nextHashes = next.messageHashes;
    const changedIndex = firstChangedMessageIndex(previousHashes, nextHashes);
    const requestPrefixChanged = previous.requestPrefixHash !== next.requestPrefixHash;
    if (isCompactionPrefixReset(options.cacheBreakIntent)) {
        if (changedIndex !== null || requestPrefixChanged) {
            notifyCacheBreak(options, {
                classification: 'intentional',
                reason: String(options.cacheBreakIntent),
                source: 'compaction',
                provider: options.provider || null,
                model: options.model || null,
                index: changedIndex,
                previousCount: previousHashes.length,
                nextCount: nextHashes.length,
                previousHash: changedIndex === null ? null : previousHashes[changedIndex],
                nextHash: changedIndex === null ? null : nextHashes[changedIndex],
                previousRequestPrefixHash: previous.requestPrefixHash,
                nextRequestPrefixHash: next.requestPrefixHash,
                requestPrefixChanged,
            });
        }
        return next;
    }

    if (nextHashes.length < previousHashes.length) {
        const details = {
            classification: 'unexpected',
            reason: 'history_shrink',
            provider: options.provider || null,
            model: options.model || null,
            kind: 'history_shrink',
            source: options.mutationSource || null,
            index: nextHashes.length,
            previousCount: previousHashes.length,
            nextCount: nextHashes.length,
            previousHash: previousHashes[nextHashes.length] || null,
            nextHash: null,
            previousRequestPrefixHash: previous.requestPrefixHash,
            nextRequestPrefixHash: next.requestPrefixHash,
            requestPrefixChanged,
        };
        notifyCacheBreak(options, details);
        throw new ProviderPrefixMutationError('provider message history shrank outside compaction', details);
    }
    for (let index = 0; index < previousHashes.length; index += 1) {
        if (previousHashes[index] === nextHashes[index]) continue;
        const details = {
            classification: 'unexpected',
            reason: 'message_prefix',
            provider: options.provider || null,
            model: options.model || null,
            kind: 'message_prefix',
            source: options.mutationSource || null,
            index,
            previousCount: previousHashes.length,
            nextCount: nextHashes.length,
            previousHash: previousHashes[index],
            nextHash: nextHashes[index],
            previousRequestPrefixHash: previous.requestPrefixHash,
            nextRequestPrefixHash: next.requestPrefixHash,
            requestPrefixChanged,
        };
        notifyCacheBreak(options, details);
        throw new ProviderPrefixMutationError('provider message prefix changed outside compaction', details);
    }
    if (requestPrefixChanged) {
        notifyCacheBreak(options, {
            classification: 'intentional',
            reason: requestPrefixChangeReason(previous, next),
            source: 'request_configuration',
            provider: options.provider || null,
            model: options.model || null,
            index: null,
            previousCount: previousHashes.length,
            nextCount: nextHashes.length,
            previousHash: null,
            nextHash: null,
            previousRequestPrefixHash: previous.requestPrefixHash,
            nextRequestPrefixHash: next.requestPrefixHash,
            requestPrefixChanged: true,
        });
        // Tool schemas are request metadata, not durable conversation state.
        // App updates may change them between turns, so rebaseline the provider
        // cache prefix after the transcript itself has passed integrity checks.
        return next;
    }
    return next;
}
