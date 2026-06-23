import { OpenAICompatProvider, OPENAI_COMPAT_PRESETS } from './openai-compat.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { GeminiProvider } from './gemini.mjs';
import { OpenAIOAuthProvider, hasOpenAIOAuthCredentials } from './openai-oauth.mjs';
import { AnthropicOAuthProvider, hasAnthropicOAuthCredentials } from './anthropic-oauth.mjs';
import { GrokOAuthProvider, hasGrokOAuthCredentials } from './grok-oauth.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';
import { refreshCatalog as refreshMetadataCatalog } from './model-catalog.mjs';
// OpenAI-compat provider names are self-declared by openai-compat.mjs via
// OPENAI_COMPAT_PRESETS. No parallel list maintained here.
const providers = new Map();
// Parallel map: provider name -> signature of the config it was built from.
// Lets initProviders() skip reconstructing a provider whose config is byte-for-
// byte identical to the live one, so lazy-init misses that re-run initProviders
// don't churn (tear down + rebuild) every live provider instance on every call.
const signatures = new Map();

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
export async function initProviders(config) {
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
    for (const [name, cfg] of entries) {
        if (!cfg.enabled)
            continue;
        // Idempotent reuse: an enabled provider whose config signature is
        // unchanged from the live registry is carried forward as-is. Only
        // added or changed providers are (re)constructed below.
        const sig = configSignature(cfg);
        if (sig !== null && providers.has(name) && signatures.get(name) === sig) {
            next.set(name, providers.get(name));
            nextSignatures.set(name, sig);
            continue;
        }
        try {
            let inst;
            if (name === 'anthropic') {
                inst = new AnthropicProvider(cfg);
            }
            else if (name === 'gemini') {
                inst = new GeminiProvider(cfg);
            }
            else if (name === 'openai-oauth') {
                inst = new OpenAIOAuthProvider(cfg);
            }
            else if (name === 'anthropic-oauth') {
                inst = new AnthropicOAuthProvider(cfg);
            }
            else if (name === 'grok-oauth') {
                inst = new GrokOAuthProvider(cfg);
            }
            else if (name === 'openai') {
                inst = new OpenAIDirectProvider(cfg);
            }
            else if (Object.prototype.hasOwnProperty.call(OPENAI_COMPAT_PRESETS, name)) {
                inst = new OpenAICompatProvider(name, cfg);
            }
            else {
                throw new Error(`unknown enabled provider: ${name}`);
            }
            next.set(name, inst);
            if (sig !== null) nextSignatures.set(name, sig);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`[provider] Failed to init "${name}": ${msg}`);
        }
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
    // instance on the spot so subsequent calls hit the cached entry.
    if (name === 'anthropic-oauth' && hasAnthropicOAuthCredentials()) {
        const inst = new AnthropicOAuthProvider({});
        providers.set(name, inst);
        return inst;
    }
    if (name === 'openai-oauth' && hasOpenAIOAuthCredentials()) {
        const inst = new OpenAIOAuthProvider({});
        providers.set(name, inst);
        return inst;
    }
    if (name === 'grok-oauth' && hasGrokOAuthCredentials()) {
        const inst = new GrokOAuthProvider({});
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
    return p?.constructor?.inputExcludesCache === true;
}
export function getAllProviders() {
    // Defensive copy — callers must not mutate the live registry or retain
    // stale entries across re-init (initProviders rebuilds the map in place).
    return new Map(providers);
}
// Background catalog warm-up. Each provider's listModels() either hits its
// own cached model list (no-op) or fires a single HTTP refresh. Called from
// agent.init() after providers are registered so the first bridge LLM call
// (e.g. cycle1 on session start) does not pay the catalog refresh latency
// inline. Fire-and-forget: failures are logged inside each provider.
export function warmupCatalogs() {
    for (const [name, provider] of providers) {
        if (typeof provider?.listModels !== 'function') continue;
        Promise.resolve()
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
    for (const [name, provider] of providers) {
        const refreshFn = typeof provider?._refreshModelCache === 'function'
            ? () => provider._refreshModelCache()
            : (typeof provider?.listModels === 'function' ? () => provider.listModels() : null);
        if (!refreshFn) continue;
        Promise.resolve()
            .then(() => refreshFn())
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[provider:${name}] startup catalog refresh failed: ${msg}\n`);
            });
    }
}

// Force-refresh provider catalogs after an operator changes model/provider
// configuration. This bypasses the 24h provider TTL where supported and warms
// the shared LiteLLM metadata cache first so context/pricing metadata follows
// newly released models without waiting for the next process restart.
export function refreshCatalogs() {
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
        Promise.resolve()
            .then(() => metadataReady)
            .then(() => refreshFn())
            .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[provider:${name}] catalog refresh failed: ${msg}\n`);
            });
    }
}
