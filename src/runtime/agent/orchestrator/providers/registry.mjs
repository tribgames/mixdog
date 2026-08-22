import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import { oauthCredentialProbeState } from './oauth-credential-probes.mjs';
import { refreshCatalog as refreshMetadataCatalog } from './model-catalog.mjs';
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
const KNOWN_INPUT_EXCLUDES_CACHE = new Set(['anthropic', 'anthropic-oauth']);
// OAuth providers are injected at runtime by buildDefaultConfig from an on-disk
// credential probe rather than persisted in mixdog-config.json. The probe is
// tri-state ('present' | 'absent' | 'unreadable'), and both the initProviders
// preservation guard and the getProvider self-heal read it through these two
// helpers so "usable right now" and "genuinely gone" are answered identically
// in both places.
const OAUTH_PROVIDER_NAMES = new Set([
    'anthropic-oauth',
    'openai-oauth',
    'grok-oauth',
    'cursor-oauth',
    'antigravity-oauth',
]);
// Providers the most recently applied config declared with enabled:false for a
// USER reason. A deliberate opt-out (logout / disable in settings) must survive
// both the preservation guard and the credential-probe self-heal — neither may
// resurrect an instance the user turned off. A load whose credential file was
// merely unreadable never lands here (see _initProvidersUnsynchronized).
let _explicitlyDisabled = new Set();

// oauthCredentialProbeState is the single owner of the tri-state read: it
// already answers 'absent' for a name it does not know and absorbs a throwing
// probe as 'unreadable' ("cannot tell", never "gone"), so both call sites below
// read it directly instead of re-wrapping those two guarantees here.
function _oauthCredentialsUsable(name) {
    return oauthCredentialProbeState(name) === 'present';
}

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
// Provider instances are process-global inside the daemon. Catalog
// readers use this revision to share one raw model snapshot while still
// rebuilding their cheap route/config projection after auth/config changes.
let _providerCatalogRevision = 0;
let _startupCatalogRefreshPromise = null;
let _catalogRefreshPromise = null;
const CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
let _catalogRefreshNotBefore = 0;
let _catalogRefreshTimer = null;

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
    if (name === 'cursor-oauth') return loadProviderExport('cursor-oauth', './cursor.mjs', 'CursorOAuthProvider', signal);
    if (name === 'antigravity-oauth') return loadProviderExport('antigravity-oauth', './antigravity-oauth.mjs', 'AntigravityOAuthProvider', signal);
    if (name === 'cursor-api') return loadProviderExport('cursor-api', './cursor.mjs', 'CursorApiProvider', signal);
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
        (v) => {
            if (_lastAppliedSig !== sig) _providerCatalogRevision += 1;
            _lastAppliedSig = sig;
            settle();
            return v;
        },
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
    // instance permanently.
    //
    // Preservation is therefore conditional, never unconditional, and rests on
    // the tri-state probe rather than on a bare `enabled:false`:
    //   - 'absent'     → the credential is genuinely gone (logout) or the user
    //                    disabled the provider: drop the instance, and
    //   - 'unreadable' → the credential file exists but could not be read this
    //                    instant: keep the instance and never record an opt-out.
    // A disabled entry counts as a USER opt-out unless buildDefaultConfig
    // marked it as "probe could not read the credential this load"
    // (credentialProbeUnavailable). That marker is authoritative in both
    // directions: loadConfig deletes it as soon as the STORED config states
    // `enabled` itself, so an explicit UI/hand-edited disable still removes the
    // provider even while its credential file happens to be unreadable, and a
    // logout (probe 'absent') never carries the marker at all.
    const nextDisabled = new Set();
    for (const [name, cfg] of entries) {
        if (cfg?.enabled) continue;
        if (OAUTH_PROVIDER_NAMES.has(name) && cfg?.credentialProbeUnavailable === true) continue;
        nextDisabled.add(name);
    }
    _explicitlyDisabled = nextDisabled;
    for (const name of OAUTH_PROVIDER_NAMES) {
        if (next.has(name) || !providers.has(name)) continue;
        if (_explicitlyDisabled.has(name)) continue;
        if (oauthCredentialProbeState(name) === 'absent') continue;
        next.set(name, providers.get(name));
        if (signatures.has(name)) nextSignatures.set(name, signatures.get(name));
    }
    throwIfAborted(signal);
    // Reconfiguration opens a new catalog epoch. A provider added (or rebuilt
    // with an empty model cache) after the startup refresh settled would
    // otherwise join that obsolete promise and never fetch its own catalog.
    const providerSetChanged = next.size !== providers.size
        || [...next].some(([name, inst]) => providers.get(name) !== inst);
    if (providerSetChanged) _startupCatalogRefreshPromise = null;
    providers.clear();
    for (const [k, v] of next) providers.set(k, v);
    signatures.clear();
    for (const [k, v] of nextSignatures) signatures.set(k, v);
}
// Register a lazily self-healed OAuth instance. Bumps the catalog revision and
// drops the settled startup-refresh epoch so the newcomer's catalog is fetched
// instead of inheriting a refresh that finished before it existed.
function _registerLazyOAuthProvider(name, Ctor) {
    const existing = providers.get(name);
    if (existing) return existing;
    const inst = wrapProviderAdmission(new Ctor({}), name);
    providers.set(name, inst);
    _providerCatalogRevision += 1;
    _startupCatalogRefreshPromise = null;
    return inst;
}
// Background module load for an OAuth provider whose constructor was never
// imported (initProviders skipped it because the credential probe was false at
// boot). getProvider() is synchronous, so this call still misses; the import
// resolves out-of-band and the NEXT call hits the registered instance.
const _oauthSelfHealLoads = new Set();
function _scheduleOAuthSelfHeal(name) {
    if (_oauthSelfHealLoads.has(name)) return;
    _oauthSelfHealLoads.add(name);
    Promise.resolve()
        .then(() => loadProviderCtor(name))
        .then((Ctor) => {
            // Re-check both gates after the await: the credential may have been
            // removed, or the provider disabled, while the import was in flight.
            if (_explicitlyDisabled.has(name)) return;
            if (!_oauthCredentialsUsable(name)) return;
            _registerLazyOAuthProvider(name, Ctor);
        })
        .catch(() => { /* self-heal is best effort */ })
        .finally(() => { _oauthSelfHealLoads.delete(name); });
}
export function getProvider(name) {
    const cached = providers.get(name);
    if (cached) return cached;
    // OAuth lazy fallback. Covers the boot-time race where the credential probe
    // returned false the first time (credential file mid-write, lock contention,
    // or a transient parse failure) — initProviders then skipped the entry
    // entirely so there is nothing for the preservation guard to carry forward.
    // Re-probe the credential on each miss and register the instance on the
    // spot. An explicitly disabled provider is never resurrected here.
    if (!OAUTH_PROVIDER_NAMES.has(name)) return undefined;
    if (_explicitlyDisabled.has(name)) return undefined;
    if (!_oauthCredentialsUsable(name)) return undefined;
    const Ctor = providerCtors.get(name);
    // A skipped provider never loaded its module, so there is no cached
    // constructor to build from. Import it in the background instead of
    // returning undefined forever, and keep registry import off every provider
    // runtime at boot.
    if (!Ctor) {
        _scheduleOAuthSelfHeal(name);
        return undefined;
    }
    return _registerLazyOAuthProvider(name, Ctor);
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
    const normalized = String(name || '').toLowerCase();
    // Usage accounting is a pure lookup. In particular, never call
    // getProvider() here: its OAuth miss path probes credentials and may lazily
    // instantiate/register a provider.
    const p = providers.get(normalized);
    if (p?.constructor && typeof p.constructor.inputExcludesCache === 'boolean') {
        return p.constructor.inputExcludesCache;
    }
    // A constructor may already be loaded even when the provider is currently
    // absent during a route/config transition. Preserve its declaration, but
    // never infer usage semantics from an arbitrary provider-name substring.
    const Ctor = providerCtors.get(normalized);
    if (Ctor && typeof Ctor.inputExcludesCache === 'boolean') {
        return Ctor.inputExcludesCache;
    }
    // Built-in usage semantics must also be correct before lazy construction
    // (including disabled providers in a fresh process).
    return KNOWN_INPUT_EXCLUDES_CACHE.has(normalized);
}
export function getAllProviders() {
    // Defensive copy — callers must not mutate the live registry or retain
    // stale entries across re-init (initProviders rebuilds the map in place).
    return new Map(providers);
}
export function providerCatalogRevision() {
    return _providerCatalogRevision;
}
// Narrow synchronous test seam for the lazy-OAuth boundary. It models a
// constructor whose module is already loaded while guaranteeing every touched
// registry entry is restored, even when the assertion callback throws.
export function _withLoadedProviderCtorForTest(name, Ctor, fn) {
    const hadProvider = providers.has(name);
    const priorProvider = providers.get(name);
    const hadCtor = providerCtors.has(name);
    const priorCtor = providerCtors.get(name);
    const hadSignature = signatures.has(name);
    const priorSignature = signatures.get(name);
    providers.delete(name);
    signatures.delete(name);
    providerCtors.set(name, Ctor);
    try {
        return fn();
    } finally {
        if (hadProvider) providers.set(name, priorProvider);
        else providers.delete(name);
        if (hadCtor) providerCtors.set(name, priorCtor);
        else providerCtors.delete(name);
        if (hadSignature) signatures.set(name, priorSignature);
        else signatures.delete(name);
    }
}
// Companion seam for registry walks that iterate live INSTANCES (what
// initProviders leaves behind) rather than constructors — the startup catalog
// refresh is one. Restores the prior entry even when the callback throws.
export function _withRegisteredProviderForTest(name, instance, fn) {
    const hadProvider = providers.has(name);
    const priorProvider = providers.get(name);
    providers.set(name, instance);
    try {
        return fn();
    } finally {
        if (hadProvider) providers.set(name, priorProvider);
        else providers.delete(name);
    }
}
// How one provider refreshes its catalog: its own _refreshModelCache when it
// has one, else a plain listModels; anything else has no catalog to refresh.
// Shared by the startup refresh and the 24h/forced refresh below.
function providerCatalogRefreshFn(provider) {
    if (typeof provider?._refreshModelCache === 'function') return () => provider._refreshModelCache();
    if (typeof provider?.listModels === 'function') return () => provider.listModels();
    return null;
}

function armNextCatalogRefresh(startedAt = Date.now()) {
    _catalogRefreshNotBefore = startedAt + CATALOG_REFRESH_INTERVAL_MS;
    if (_catalogRefreshTimer) clearTimeout(_catalogRefreshTimer);
    _catalogRefreshTimer = setTimeout(() => {
        _catalogRefreshTimer = null;
        void refreshCatalogs();
    }, Math.max(1, _catalogRefreshNotBefore - Date.now()));
    _catalogRefreshTimer.unref?.();
}

// Force-refresh each provider's /models catalog once at daemon boot. Every
// session runtime joins this process-global promise and reads the same
// provider-instance caches. The next network refresh is armed for 24h later;
// view entry, search, settings, and explicit refresh requests inside that
// window only reuse the completed catalog epoch.
export function refreshProviderCatalogsOnStartup() {
    if (_startupCatalogRefreshPromise) return _startupCatalogRefreshPromise;
    armNextCatalogRefresh();
    const pending = [];
    for (const [name, provider] of providers) {
        const refreshFn = providerCatalogRefreshFn(provider);
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
    _startupCatalogRefreshPromise = Promise.allSettled(pending).then((results) => {
        _providerCatalogRevision += 1;
        return results;
    });
    return _startupCatalogRefreshPromise;
}

// Refresh the complete catalog at most once per 24h process window. The timer
// above calls this automatically when the window expires; callers may bypass
// that window after an explicit auth/config/model-refresh action.
export function refreshCatalogs(options = {}) {
    if (_catalogRefreshPromise) return _catalogRefreshPromise;
    if (options?.force !== true && Date.now() < _catalogRefreshNotBefore) {
        if (!_catalogRefreshTimer) {
            armNextCatalogRefresh(_catalogRefreshNotBefore - CATALOG_REFRESH_INTERVAL_MS);
        }
        return _startupCatalogRefreshPromise || Promise.resolve([]);
    }
    armNextCatalogRefresh();
    const pending = [];
    const metadataReady = Promise.resolve()
        .then(() => refreshMetadataCatalog())
        .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[model-catalog] metadata refresh failed: ${msg}\n`);
            return null;
        });
    for (const [name, provider] of providers) {
        const refreshFn = providerCatalogRefreshFn(provider);
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
    _catalogRefreshPromise = Promise.allSettled([metadataReady, ...pending])
        .then((results) => {
            _providerCatalogRevision += 1;
            return results;
        })
        .finally(() => {
            _catalogRefreshPromise = null;
        });
    return _catalogRefreshPromise;
}
