// Lazy lookup of a session's AbortSignal without import-cycling against
// session/manager.mjs. The session manager is loaded once on first call;
// further lookups hit the cached resolver.
let _resolver = null;

export async function getAbortSignalForSession(sessionId) {
    if (!sessionId) return null;
    if (!_resolver) {
        const mod = await import('./manager.mjs');
        _resolver = typeof mod.getSessionAbortSignal === 'function' ? mod.getSessionAbortSignal : null;
    }
    return _resolver ? _resolver(sessionId) : null;
}
