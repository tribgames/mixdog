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

function snapshot(messages, requestPrefix) {
    return {
        messageHashes: messages.map(digest),
        requestPrefixHash: digest(requestPrefix),
    };
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
    const next = snapshot(Array.isArray(messages) ? messages : [], requestPrefix);
    if (!previous || isCompactionPrefixReset(options.cacheBreakIntent)) return next;

    if (previous.requestPrefixHash !== next.requestPrefixHash) {
        throw new ProviderPrefixMutationError('provider request prefix changed outside compaction', {
            provider: options.provider || null,
            kind: 'request_prefix',
        });
    }
    if (next.messageHashes.length < previous.messageHashes.length) {
        throw new ProviderPrefixMutationError('provider message history shrank outside compaction', {
            provider: options.provider || null,
            kind: 'history_shrink',
        });
    }
    for (let index = 0; index < previous.messageHashes.length; index += 1) {
        if (previous.messageHashes[index] === next.messageHashes[index]) continue;
        throw new ProviderPrefixMutationError('provider message prefix changed outside compaction', {
            provider: options.provider || null,
            kind: 'message_prefix',
            index,
        });
    }
    return next;
}
