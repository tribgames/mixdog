/**
 * Provider-owned assistant output that must be replayed in its original item
 * order. Flattened content/tool/reasoning projections remain available to the
 * agent loop, but provider adapters prefer this envelope when rebuilding wire
 * history for the same provider family.
 */
const PROVIDER_REPLAY_VERSION = 1;

function cloneReplayValue(value) {
    try { return structuredClone(value); }
    catch {
        try { return JSON.parse(JSON.stringify(value)); }
        catch { return value; }
    }
}

export function createProviderReplay(provider, items) {
    const id = typeof provider === 'string' ? provider.trim() : '';
    if (!id || !Array.isArray(items) || items.length === 0) return undefined;
    return {
        version: PROVIDER_REPLAY_VERSION,
        provider: id,
        items: cloneReplayValue(items),
    };
}

export function cloneProviderReplay(replay) {
    if (!replay || typeof replay !== 'object'
        || replay.version !== PROVIDER_REPLAY_VERSION
        || typeof replay.provider !== 'string' || !replay.provider
        || !Array.isArray(replay.items) || replay.items.length === 0) {
        return undefined;
    }
    const cloned = createProviderReplay(replay.provider, replay.items);
    if (typeof replay.accountId === 'string') cloned.accountId = replay.accountId;
    // Adapter-owned request context is persisted with the original response,
    // but is never part of the provider-visible output items.
    if (replay.requestContext && typeof replay.requestContext === 'object'
        && !Array.isArray(replay.requestContext)) {
        cloned.requestContext = cloneReplayValue(replay.requestContext);
    }
    return cloned;
}

export function providerReplayItems(messageOrReplay, acceptedProviders) {
    const replay = messageOrReplay?.providerReplay ?? messageOrReplay;
    const cloned = cloneProviderReplay(replay);
    if (!cloned) return undefined;
    const accepted = Array.isArray(acceptedProviders)
        ? new Set(acceptedProviders)
        : new Set([acceptedProviders]);
    if (!accepted.has(cloned.provider)) return undefined;
    return cloned.items;
}
