import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import {
    hasAnthropicOAuthCredentials,
    hasOpenAIOAuthCredentials,
    hasGrokOAuthCredentials,
} from './oauth-credential-probes.mjs';
import { refreshCatalog as refreshMetadataCatalog, warmModelMetadataCatalogs } from './model-catalog.mjs';
import { wrapProviderAdmission } from './admission-scheduler.mjs';
// OpenAI-compat provider names are self-declared by openai-compat-presets.mjs via
// OPENAI_COMPAT_PRESETS. No parallel list maintained here.
const providers = new Map();
const providerCtors = new Map();
const providerModulePromises = new Map();
// Parallel map: provider name -> signature of the config it was built from.
// Lets initProviders() skip reconstructing a provider whose config is byte-for-
// byte identical to the live one, so lazy-init misses that re-run initProviders
// don't churn (tear down + rebuild) every live provider instance on every call.
const signatures = new Map();

// Module-level init serialization. agent-tool.mjs's ensureProvider() already
// serializes inits per provider on a chain promise, but its gateOnPrior() lets
// a queued init PROCEED once a 120s gate expires even if the prior init has
// not settled — so a slow-but-still-running init and a newer one can reach
// initProviders() concurrently. This chain makes the clear()+rebuild section
// strictly sequential at the registry level, independent of any caller gating,
// so two different config signatures can never interleave their rebuilds.
let _initChain = Promise.resolve();
// Singleflight state layered on top of the serial chain. Under simultaneous
// multi-agent launch, many callers hit initProviders() with a byte-identical
// config. `_inFlightPromise`/`_inFlightSig` coalesce those onto the pending
// init instead of queueing redundant clear()+rebuild passes behind it, and
// `_lastAppliedSig` lets a repeat call short-circuit entirely once the chain
// is idle. Differing signatures still serialize through _initChain as before.
let _inFlightPromise = null;
let _inFlightSig = null;
let _lastAppliedSig = null;

// Deterministic structural signature of a provider config. Recursively sorts
// object keys so signature equality reflects config-value equality regardless
// of key insertion order. Invariant: same config in -> same string out.
function sortKeysDeep(v) {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
        return out;
    }
    return v;
}
function configSignature(cfg) {
    try {
        return JSON.stringify(sortKeysDeep(cfg));
    } catch {
        // Non-serializable config (cycles / exotic values): force a rebuild by
        // returning a never-matching signature rather than risk a stale reuse.
        return null;
    }
}

function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || 'provider initialization aborted'));
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function awaitWithAbort(promise, signal) {
    if (!(signal instanceof AbortSignal)) return promise;
    throwIfAborted(signal);
    let listener = null;
    const aborted = new Promise((_, reject) => {
        listener = () => reject(abortError(signal));
        signal.addEventListener('abort', listener, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => {
        if (listener) {
            try { signal.removeEventListener('abort', listener); } catch { /* ignore */ }
        }
    });
}

async function loadProviderExport(cacheKey, spec, exportName, signal = null) {
    if (!providerModulePromises.has(cacheKey)) {
        providerModulePromises.set(cacheKey, import(spec));
    }
    const mod = await awaitWithAbort(providerModulePromises.get(cacheKey), signal);
    throwIfAborted(signal);
    const value = mod?.[exportName];
    if (typeof value !== 'function') throw new Error(`provider export missing: ${exportName}`);
    throwIfAborted(signal);
    providerCtors.set(cacheKey, value);
    return value;
}

async function loadProviderCtor(name, signal = null) {
    if (name === 'anthropic') return loadProviderExport('anthropic', './anthropic.mjs', 'AnthropicProvider', signal);
    if (name === 'gemini') return loadProviderExport('gemini', './gemini.mjs', 'GeminiProvider', signal);
    if (name === 'openai-oauth') return loadProviderExport('openai-oauth', './openai-oauth.mjs', 'OpenAIOAuthProvider', signal);
    if (name === 'anthropic-oauth') return loadProviderExport('anthropic-oauth', './anthropic-oauth.mjs', 'AnthropicOAuthProvider', signal);
    if (name === 'grok-oauth') return loadProviderExport('grok-oauth', './grok-oauth.mjs', 'GrokOAuthProvider', signal);
    if (name === 'openai') return loadProviderExport('openai', './openai-ws.mjs', 'OpenAIDirectProvider', signal);
    if (name === 'opencode-go') return loadProviderExport('opencode-go', './opencode-go.mjs', 'OpenCodeGoProvider', signal);
    if (Object.prototype.hasOwnProperty.call(OPENAI_COMPAT_PRESETS, name)) {
        return loadProviderExport('openai-compat', './openai-compat.mjs', 'OpenAICompatProvider', signal);
    }
    throw new Error(`unknown enabled provider: ${name}`);
}

function instantiateProvider(name, Ctor, cfg) {
    if (Object.prototype.hasOwnProperty.call(OPENAI_COMPAT_PRESETS, name) && name !== 'opencode-go') {
        return wrapProviderAdmission(new Ctor(name, cfg), name);
    }
    return wrapProviderAdmission(new Ctor(cfg), name);
}

export async function initProviders(config, { signal = null } = {}) {
    throwIfAborted(signal);
    const sig = configSignature(config);
    // Coalesce: an identical config is already mid-init — attach to it.
    if (sig !== null && _inFlightPromise && _inFlightSig === sig) {
        return awaitWithAbort(_inFlightPromise, signal);
    }
    // Fast path: chain idle and the live registry already reflects this exact
    // config — nothing to tear down or rebuild.
    if (sig !== null && !_inFlightPromise && _lastAppliedSig === sig) {
        return;
    }
    // Serialize ALL inits through a single chain so two different config
    // signatures can never run their clear()+rebuild concurrently, regardless
    // of caller-side gating (agent-tool gateOnPrior may release a queued init
    // before the prior one settled). Errors do not poison the chain.
    const run = () => _initProvidersUnsynchronized(config, signal);
    const next = _initChain.then(run, run);
    _initChain = next.then(() => {}, () => {});
    const settle = () => {
        if (_inFlightPromise === tracked) {
            _inFlightPromise = null;
            _inFlightSig = null;
        }
    };
    const tracked = next.then(
        (v) => { _lastAppliedSig = sig; settle(); return v; },
        (err) => { settle(); throw err; },
    );
    _inFlightSig = sig;
    _inFlightPromise = tracked;
    return awaitWithAbort(tracked, signal);
}

async function _initProvidersUnsynchronized(config, signal = null) {
    throwIfAborted(signal);
    // Invariant: never wipe the live registry based on an empty / all-disabled
    // config. Without this guard, a stale `loadAgentConfig()` (e.g. mid-reload
    // or a transient FS hiccup) would land here as `{}` or `{...,enabled:false}`,
    // and the `providers.clear()` at the bottom would erase every previously
    // registered provider. The owner process then stays alive returning
    // `Provider "<name>" not found or not enabled` until restart. Throwing
    // here preserves whatever was already registered.
    const entries = Object.entries(config || {});
    if (entries.length === 0) {
        throw new Error('[provider] initProviders called with empty config — refusing to clear registry');
    }
    const next = new Map();
    const nextSignatures = new Map();
    const enabledResults = await Promise.all(entries.map(async ([name, cfg]) => {
        if (!cfg.enabled) return null;
        // Idempotent reuse: an enabled provider whose config signature is
        // unchanged from the live registry is carried forward as-is. Only
        // added or changed providers are (re)constructed below.
        const sig = configSignature(cfg);
        if (sig !== null && providers.has(name) && signatures.get(name) === sig) {
            return { name, inst: providers.get(name), sig };
        }
        try {
            const Ctor = await loadProviderCtor(name, signal);
            throwIfAborted(signal);
            const inst = instantiateProvider(name, Ctor, cfg);
            return { name, inst, sig };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { name, error: new Error(`[provider] Failed to init "${name}": ${msg}`) };
        }
    }));
    for (const result of enabledResults) {
        throwIfAborted(signal);
        if (!result) continue;
        if (result.error) throw result.error;
        next.set(result.name, result.inst);
        if (result.sig !== null) nextSignatures.set(result.name, result.sig);
    }
    // Second guard: every entry was disabled. Same reasoning — keep the
    // existing registry rather than going dark.
    if (next.size === 0) {
        throw new Error('[provider] all providers disabled in config — refusing to clear registry');
    }
    // OAuth preservation guard. anthropic-oauth / openai-oauth are NOT stored
    // in mixdog-config.json — buildDefaultConfig injects them at runtime by
    // calling hasAnthropic/OpenAIOAuthCredentials(), which reads the on-disk
    // credentials file each call. A transient ENOENT / partial-write / JSON
    // parse failure quietly returns false, the OAuth entry lands in next as
    // disabled (silently skipped by the `!cfg.enabled` continue above), and
    // the `providers.clear()` below would erase the previously registered
    // instance permanently — the process then returns
    // `Provider "anthropic-oauth" not found or not enabled` for the rest of
    // its lifetime even though the credential file is fine again. Carry
    // forward the prior instance instead.
    for (const name of ['anthropic-oauth', 'openai-oauth', 'grok-oauth']) {
        if (!next.has(name) && providers.has(name)) {
            next.set(name, providers.get(name));
            if (signatures.has(name)) nextSignatures.set(name, signatures.get(name));
        }
    }
    throwIfAborted(signal);
    providers.clear();
    for (const [k, v] of next) providers.set(k, v);
    signatures.clear();
    for (const [k, v] of nextSignatures) signatures.set(k, v);
}
export function getProvider(name) {
    const cached = providers.get(name);
    if (cached) return cached;
    // OAuth lazy fallback. Covers the boot-time race where
    // hasAnthropic/OpenAIOAuthCredentials() returned false the first time
    // (credential file mid-write, lock contention, or a transient parse
    // failure) — initProviders then skipped the entry entirely so there is
    // nothing for the preservation guard to carry forward. Re-probe the
    // credential each miss: if the credential is now valid, register the
    // instance on the spot when that provider module has already been loaded,
    // so subsequent calls hit the cached entry without making registry import
    // pay every provider runtime at boot.
    if (name === 'anthropic-oauth' && hasAnthropicOAuthCredentials()) {
        const Ctor = providerCtors.get('anthropic-oauth');
        if (!Ctor) return undefined;
        const inst = wrapProviderAdmission(new Ctor({}), name);
        providers.set(name, inst);
        return inst;
    }
    if (name === 'openai-oauth' && hasOpenAIOAuthCredentials()) {
        const Ctor = providerCtors.get('openai-oauth');
        if (!Ctor) return undefined;
        const inst = wrapProviderAdmission(new Ctor({}), name);
        providers.set(name, inst);
        return inst;
    }
    if (name === 'grok-oauth' && hasGrokOAuthCredentials()) {
        const Ctor = providerCtors.get('grok-oauth');
        if (!Ctor) return undefined;
        const inst = wrapProviderAdmission(new Ctor({}), name);
        providers.set(name, inst);
        return inst;
    }
    return undefined;
}
// Whether a provider reports usage.input_tokens EXCLUDING cached tokens
// (Anthropic) rather than INCLUDING them (openai / gemini / grok). Used to
// normalize the live "context window" footprint in session metrics: for a
// cache-excluding provider the cache_read count must be added back to reflect
// what the model actually saw last turn. The convention is declared as a
// static `inputExcludesCache` on each provider class, so a newly added
// provider states its own answer — no central regex to keep in sync. Unknown /
// unregistered providers default to false (the openai/gemini majority).
export function providerInputExcludesCache(name) {
    const p = getProvider(name);
    if (p?.constructor?.inputExcludesCache === true) return true;
    return String(name || '').toLowerCase().includes('anthropic');
}
export function getAllProviders() {
    // Defensive copy — callers must not mutate the live registry or retain
    // stale entries across re-init (initProviders rebuilds the map in place).
    return new Map(providers);
}
// Background catalog warm-up. Each provider's listModels() either hits its
// own cached model list (no-op) or fires a single HTTP refresh. Called from
// agent.init() after providers are registered so the first agent dispatch call
// (e.g. cycle1 on session start) does not pay the catalog refresh latency
// inline. Fire-and-forget: failures are logged inside each provider.
export function warmupCatalogs() {
    const metadataReady = Promise.resolve()
        .then(() => warmModelMetadataCatalogs())
        .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[model-catalog] metadata warm-up failed: ${msg}\n`);
            return null;
        });
    for (const [name, provider] of providers) {
        if (typeof provider?.listModels !== 'function') continue;
        Promise.resolve()
            .then(() => metadataReady)
            .then(() => provider.listModels())
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[provider:${name}] catalog warm-up failed: ${msg}\n`);
            });
    }
}

// Force-refresh each provider's /models catalog on every MCP start. Unlike
// warmupCatalogs (which calls listModels() and so respects the 24h provider
// TTL → no-op when the cache is fresh), this bypasses the TTL via
// _refreshModelCache so a model released since the last refresh is picked up
// at startup instead of waiting for TTL expiry. Deliberately does NOT touch
// the shared LiteLLM metadata catalog (refreshMetadataCatalog) — pricing /
// context metadata stays on its own 24h TTL. Fire-and-forget: never awaited,
// per-provider failures logged to stderr like warmupCatalogs.
export function refreshProviderCatalogsOnStartup() {
    const pending = [];
    for (const [name, provider] of providers) {
        const refreshFn = typeof provider?._refreshModelCache === 'function'
            ? () => provider._refreshModelCache()
            : (typeof provider?.listModels === 'function' ? () => provider.listModels() : null);
        if (!refreshFn) continue;
        pending.push(Promise.resolve()
            .then(() => refreshFn())
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[provider:${name}] startup catalog refresh failed: ${msg}\n`);
            }));
    }
    // Returns a completion promise so callers can invalidate stale model
    // caches once the fresh catalogs land. Still fire-and-forget: unawaited
    // callers keep the previous nonblocking startup behavior.
    return Promise.allSettled(pending);
}

// Force-refresh provider catalogs after an operator changes model/provider
// configuration. This bypasses the 24h provider TTL where supported and warms
// the shared LiteLLM metadata cache first so context/pricing metadata follows
// newly released models without waiting for the next process restart.
export function refreshCatalogs() {
    const pending = [];
    const metadataReady = Promise.resolve()
        .then(() => refreshMetadataCatalog())
        .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[model-catalog] metadata refresh failed: ${msg}\n`);
            return null;
        });
    for (const [name, provider] of providers) {
        const refreshFn = typeof provider?._refreshModelCache === 'function'
            ? () => provider._refreshModelCache()
            : (typeof provider?.listModels === 'function' ? () => provider.listModels() : null);
        if (!refreshFn) continue;
        pending.push(Promise.resolve()
            .then(() => metadataReady)
            .then(() => refreshFn())
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[provider:${name}] catalog refresh failed: ${msg}\n`);
            }));
    }
    // Completion promise: lets callers drop stale model caches after refresh.
    return Promise.allSettled([metadataReady, ...pending]);
}
