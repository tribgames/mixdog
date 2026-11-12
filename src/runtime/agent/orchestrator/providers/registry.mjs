import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import { oauthCredentialProbeState } from './oauth-credential-probes.mjs';
import { providerAvailable } from './provider-availability.mjs';
import { refreshCatalog as refreshMetadataCatalog } from './model-catalog.mjs';
import { wrapProviderAdmission } from './admission-scheduler.mjs';
import { createAccountPoolProvider, createCustomKeyPoolProvider } from './account-pool.mjs';
import { customKeyEngine } from './custom-provider-keys.mjs';
import { customProviderKeyIds } from '../../../shared/provider-accounts.mjs';
import { isInclusiveProvider } from '../../../shared/llm/cost.mjs';
import { noEnabledProvidersError } from './registry-errors.mjs';
import { providerTakesNativePdf } from '../../../attachments/store.mjs';
import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';
import { getModelProxyChannel } from './model-proxy-channel.mjs';
import { boundedProviderCatalogOp } from './catalog-deadline.mjs';
// OpenAI-compat provider names are self-declared by openai-compat-presets.mjs via
// OPENAI_COMPAT_PRESETS. No parallel list maintained here.
// Ownership. The process-global provider set has one owner: the config of
// record (the full, secrets-aware config and the stored provider decisions).
//   - initProviders(config) is the additive "ensure registered" request every
//     runtime and helper makes: it registers the enabled providers that are
//     missing and never rebuilds or removes a registered one, so a partial
//     view (a secrets-less load, one route's forced provider) cannot shrink
//     or churn the set.
//   - syncProviders(record, { decisions }) applies the config of record:
//     registered providers are rebuilt when their config signature changed,
//     and removed only by a stored decision (enabled:false — what disable and
//     logout write — or a deleted custom provider). A credential that could
//     not be read is never a decision, so it never removes a provider.
//   - disableProvider(name) is the immediate form of such a decision.
const providers = new Map();
const providerCtors = new Map();
const providerModulePromises = new Map();
// Parallel map: provider name -> signature of the config it was built from.
const signatures = new Map();
// OAuth providers are injected at runtime by buildDefaultConfig from an on-disk
// credential probe rather than persisted in mixdog-config.json. getProvider
// registers one lazily once its credential reads as present.
export const OAUTH_PROVIDER_NAMES = new Set([
  'anthropic-oauth',
  'openai-oauth',
  'grok-oauth',
  'muse-code-oauth',
  'command-code-oauth',
  'mimo-oauth',
  'cursor-oauth',
  'devin-oauth',
  'antigravity-oauth',
  'opencode-go-oauth',
]);
// OAuth providers a stored decision turned off (logout / disable in settings).
// The lazy registration in getProvider never resurrects one.
let _explicitlyDisabled = new Set();

function _oauthCredentialsUsable(name) {
  return oauthCredentialProbeState(name) === 'present';
}

// Every registry mutation (register, rebuild, remove) runs on this chain, so
// two applies never interleave their builds. Errors do not poison it.
let _applyChain = Promise.resolve();
// Settles when a provider set first applies.
let _markProvidersInitialized;
const _providersInitialized = new Promise((resolve) => {
  _markProvidersInitialized = resolve;
});

/** Read-only readiness: resolves once a provider set has first applied
 *  (never starts one). */
export function providersInitialized() {
  return _providersInitialized;
}
// Provider instances are process-global inside the daemon. Catalog
// readers use this revision to share one raw model snapshot while still
// rebuilding their cheap route/config projection after auth/config changes.
let _providerCatalogRevision = 0;
// The boot catalog refresh fetches each provider once per config signature:
// name -> the signature whose catalog it fetched (or is fetching). A provider
// added, or rebuilt from a changed config, is fetched; an unchanged one never
// again until the 24h refresh.
const _catalogRefreshedSigs = new Map();
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

// Remote mode: a proxy provider sends through the channel it was built on. A
// headless boundary installs a fresh channel per run (model-proxy-bridge.mjs)
// and closes it afterwards, so the channel's identity is part of every reuse
// signature — an identical PC config behind a new channel is a rebuild, never
// a provider bound to a closed channel. Local mode: '' (signatures unchanged).
const _proxyChannelIds = new WeakMap();
let _proxyChannelSeq = 0;
function proxyChannelTag(channel) {
  if (!channel) return '';
  let id = _proxyChannelIds.get(channel);
  if (!id) {
    _proxyChannelSeq += 1;
    id = _proxyChannelSeq;
    _proxyChannelIds.set(channel, id);
  }
  return `\u0000model-proxy-channel:${id}`;
}
function reuseSignature(cfg, proxyChannel) {
  const sig = configSignature(cfg);
  return sig === null ? null : sig + proxyChannelTag(proxyChannel);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'provider initialization aborted'));
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
      try {
        signal.removeEventListener('abort', listener);
      } catch {
        /* ignore */
      }
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

// Provider name -> [module, exported constructor] for the dedicated providers;
// every other preset name is served by the shared OpenAI-compat constructor.
const PROVIDER_MODULES = {
  anthropic: ['./anthropic.mjs', 'AnthropicProvider'],
  gemini: ['./gemini.mjs', 'GeminiProvider'],
  'vertex-ai': ['./vertex-ai.mjs', 'VertexAIProvider'],
  'openai-oauth': ['./openai-oauth.mjs', 'OpenAIOAuthProvider'],
  'anthropic-oauth': ['./anthropic-oauth.mjs', 'AnthropicOAuthProvider'],
  'grok-oauth': ['./grok-oauth.mjs', 'GrokOAuthProvider'],
  'muse-code-oauth': ['./muse-code-oauth.mjs', 'MuseCodeOAuthProvider'],
  'command-code-oauth': ['./command-code-oauth.mjs', 'CommandCodeOAuthProvider'],
  'mimo-oauth': ['./mimo-oauth.mjs', 'MimoOAuthProvider'],
  'cursor-oauth': ['./cursor.mjs', 'CursorOAuthProvider'],
  'devin-oauth': ['./devin.mjs', 'DevinOAuthProvider'],
  'antigravity-oauth': ['./antigravity-oauth.mjs', 'AntigravityOAuthProvider'],
  'cursor-api': ['./cursor.mjs', 'CursorApiProvider'],
  openai: ['./openai-ws.mjs', 'OpenAIDirectProvider'],
  'mixdog-local': ['./mixdog-local.mjs', 'MixdogLocalProvider'],
  'opencode-go-oauth': ['./opencode-go-oauth.mjs', 'OpenCodeGoOAuthProvider'],
  // Multi-wire preset gateways (wire-route.mjs picks the wire per model).
  openrouter: ['./openrouter.mjs', 'OpenRouterProvider'],
  deepseek: ['./deepseek.mjs', 'DeepSeekProvider'],
};

// User-defined providers (cfg.type === 'custom') are keyed by a generated
// `custom-<uuid>` id and never collide with the built-in names.
function isCustomProviderConfig(name, cfg) {
  return cfg?.type === 'custom' && String(name).startsWith('custom-');
}

async function loadProviderCtor(name, signal = null, cfg = null) {
  if (isCustomProviderConfig(name, cfg)) {
    return loadProviderExport('custom-provider', './custom-provider.mjs', 'createCustomProvider', signal);
  }
  if (Object.hasOwn(PROVIDER_MODULES, name)) {
    const [spec, exportName] = PROVIDER_MODULES[name];
    return loadProviderExport(name, spec, exportName, signal);
  }
  if (Object.hasOwn(OPENAI_COMPAT_PRESETS, name)) {
    return loadProviderExport('openai-compat', './openai-compat.mjs', 'OpenAICompatProvider', signal);
  }
  throw new Error(`unknown enabled provider: ${name}`);
}

async function instantiateProvider(name, Ctor, cfg, proxyChannel = null) {
  // Remote mode: the client PC executes the call with its own credentials.
  // Admission and usage accounting still wrap the daemon-side stand-in.
  if (modelProxyClientMode()) {
    const { createModelProxyProvider } = await import('./model-proxy-provider.mjs');
    return wrapProviderAdmission(createModelProxyProvider(name, cfg, proxyChannel ?? getModelProxyChannel()), name);
  }
  if (isCustomProviderConfig(name, cfg)) {
    const { [CUSTOM_KEY_IDS]: keyIds, ...settings } = cfg;
    const primary = wrapProviderAdmission(await Ctor(name, settings), name);
    // Only a provider with additional keys sends through the key roster.
    if (!keyIds?.length) return primary;
    return createCustomKeyPoolProvider(name, primary, (id) => customKeyEngine(primary, name, id));
  }
  if (Object.hasOwn(OPENAI_COMPAT_PRESETS, name) && !Object.hasOwn(PROVIDER_MODULES, name)) {
    return wrapProviderAdmission(new Ctor(name, cfg), name);
  }
  return createAccountPoolProvider(name, () => wrapProviderAdmission(new Ctor(cfg), name));
}

// A custom provider's additional keys live in its key roster, not the config.
// Their ids are read once per init and join its entry (and so its reuse
// signature): a save that changes them rebuilds the provider, which is wrapped
// in the key pool only while it has some. A single-key provider's entry and
// sends stay as they were, with no roster read per send.
const CUSTOM_KEY_IDS = 'customKeyIds';

function withCustomKeyIds(config) {
  if (!config || typeof config !== 'object') return config;
  let out = config;
  for (const [name, cfg] of Object.entries(config)) {
    if (!isCustomProviderConfig(name, cfg) || cfg.auth === 'none') continue;
    const ids = customProviderKeyIds(name);
    if (!ids.length) continue;
    if (out === config) out = { ...config };
    out[name] = { ...cfg, [CUSTOM_KEY_IDS]: ids };
  }
  return out;
}

let _initProvidersCalls = 0;
/** Test seam: how many times initProviders was called in this process. */
export function _initProvidersCallCountForTest() {
  return _initProvidersCalls;
}

/** Ensure the providers `config` enables are registered (additive). A missing
 *  enabled provider is built and registered; a registered one is left as it
 *  is, whatever this config says about it. Rejects with NO_ENABLED_PROVIDERS
 *  when the registry is still empty afterwards. Remote mode applies the PC's
 *  provider config, the record there (applyModelProxyRecord). */
export async function initProviders(config, { signal = null } = {}) {
  _initProvidersCalls += 1;
  throwIfAborted(signal);
  if (modelProxyClientMode()) return applyModelProxyRecord(signal);
  const plan = { config: withCustomKeyIds(config), rebuild: false, add: true, isOff: null, proxyChannel: null };
  // Nothing to add: answer without queueing behind an unrelated apply.
  if (providers.size > 0 && !pendingBuilds(plan).length) return;
  return applyOnChain(plan, signal);
}

/** Apply the config of record: rebuild every registered provider whose
 *  config signature changed and remove the ones a stored decision turned off.
 *  `decisions` is the stored providers section (null when it could not be
 *  read: no decision is known, so nothing is removed). Never adds a provider
 *  (initProviders registers them on demand), never rejects for an empty set. */
export async function syncProviders(record, { decisions = null, signal = null } = {}) {
  throwIfAborted(signal);
  if (modelProxyClientMode()) return applyModelProxyRecord(signal);
  const isOff = decisions
    ? (name) =>
        decisions[name]?.enabled === false || (String(name).startsWith('custom-') && !Object.hasOwn(decisions, name))
    : null;
  return applyOnChain({ config: withCustomKeyIds(record), rebuild: true, add: false, isOff, proxyChannel: null }, signal);
}

// Remote mode: the PC's provider config is the record, read here for every
// request; a provider it does not enable is off, and the proxy channel is part
// of every signature (a new channel rebuilds).
async function applyModelProxyRecord(signal) {
  const proxyChannel = getModelProxyChannel();
  const { loadModelProxyProviderConfig } = await import('./model-proxy-provider.mjs');
  const config = await awaitWithAbort(loadModelProxyProviderConfig({ channel: proxyChannel }), signal);
  const isOff = (name) => config?.[name]?.enabled !== true;
  return applyOnChain({ config, rebuild: true, add: true, isOff, proxyChannel }, signal);
}

function applyOnChain(plan, signal) {
  const run = () => applyProviderPlan(plan, signal);
  const next = _applyChain.then(run, run);
  _applyChain = next.then(
    () => {},
    () => {}
  );
  return awaitWithAbort(next, signal);
}

// The enabled entries of a plan's config that need a build: missing ones when
// it adds, changed ones when it rebuilds.
function pendingBuilds({ config, add, rebuild, proxyChannel }) {
  const out = [];
  for (const [name, cfg] of Object.entries(config || {})) {
    if (cfg?.enabled !== true) continue;
    // A dev-gated provider whose Developer option is off is never admitted,
    // even from a config that still says enabled:true.
    if (!providerAvailable(name)) continue;
    // A retired provider's saved config is inert: its replacement is its own entry.
    if (Object.hasOwn(RETIRED_PROVIDER_ALIASES, name)) continue;
    const sig = reuseSignature(cfg, proxyChannel);
    const registered = providers.has(name);
    if (registered ? rebuild && (sig === null || signatures.get(name) !== sig) : add) out.push({ name, cfg, sig });
  }
  return out;
}

async function buildProvider({ name, cfg, sig }, proxyChannel, signal) {
  try {
    // A proxied provider never loads the real adapter module.
    const Ctor = modelProxyClientMode() ? null : await loadProviderCtor(name, signal, cfg);
    throwIfAborted(signal);
    return { name, inst: await instantiateProvider(name, Ctor, cfg, proxyChannel), sig };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = new Error(`[provider] Failed to init "${name}": ${msg}`);
    // One invalid custom provider is isolated: it is skipped (never partially
    // loaded) and reported, the rest of the registry builds.
    if (isCustomProviderConfig(name, cfg) && !signal?.aborted) return { name, error, isolated: true };
    return { name, error };
  }
}

async function applyProviderPlan(plan, signal) {
  throwIfAborted(signal);
  const results = await Promise.all(pendingBuilds(plan).map((entry) => buildProvider(entry, plan.proxyChannel, signal)));
  throwIfAborted(signal);
  const failed = results.find((result) => result.error && !result.isolated);
  if (failed) throw failed.error;
  const skipped = [];
  for (const result of results) {
    if (result.isolated) {
      // A registered provider always reflects its current config: one whose
      // config no longer builds leaves the registry with its reason.
      removeProvider(result.name);
      _providerInitErrors.set(result.name, result.error.message);
      skipped.push(result.error.message);
      process.stderr.write(`${result.error.message} (provider skipped; fix its configuration)\n`);
      continue;
    }
    registerProvider(result.name, result.inst, result.sig);
  }
  if (plan.isOff) {
    for (const name of [...providers.keys(), ..._providerInitErrors.keys()]) {
      if (plan.isOff(name)) removeProvider(name);
    }
    _explicitlyDisabled = new Set([...OAUTH_PROVIDER_NAMES].filter(plan.isOff));
  }
  if (plan.add && providers.size === 0) {
    throw noEnabledProvidersError(
      `[provider] no provider is enabled${skipped.length ? `; invalid custom providers skipped: ${skipped.join('; ')}` : ''}`
    );
  }
  if (providers.size > 0) _markProvidersInitialized();
}

function registerProvider(name, inst, sig) {
  providers.set(name, inst);
  if (sig === null) signatures.delete(name);
  else signatures.set(name, sig);
  _explicitlyDisabled.delete(name);
  _providerInitErrors.delete(name);
  _providerCatalogRevision += 1;
}

function removeProvider(name) {
  _providerInitErrors.delete(name);
  signatures.delete(name);
  _catalogRefreshedSigs.delete(name);
  if (!providers.delete(name)) return false;
  _providerCatalogRevision += 1;
  return true;
}

// Custom providers whose config failed to build, by name → error message.
const _providerInitErrors = new Map();
export function getProviderInitErrors() {
  return new Map(_providerInitErrors);
}
// Register a lazily self-healed OAuth instance under the signature of the
// empty config it was built from: a sync of a record that enables it rebuilds
// it from that entry.
function _registerLazyOAuthProvider(name, Ctor) {
  const existing = providers.get(name);
  if (existing) return existing;
  const inst = wrapProviderAdmission(new Ctor({}), name);
  registerProvider(name, inst, configSignature({}));
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
    .catch(() => {
      /* self-heal is best effort */
    })
    .finally(() => {
      _oauthSelfHealLoads.delete(name);
    });
}
// Provider ids that were retired: a saved route or session naming one is served
// by its replacement account. When that account is not connected the lookup
// misses like any other unconnected provider.
const RETIRED_PROVIDER_ALIASES = Object.freeze({ 'opencode-go': 'opencode-go-oauth' });

/** The instance registered under `name` right now, or null — a read-only
 *  lookup (no lazy registration, unlike getProvider). */
export function registeredProvider(name) {
  return providers.get(name) || null;
}

export function getProvider(requestedName) {
  const name = Object.hasOwn(RETIRED_PROVIDER_ALIASES, requestedName)
    ? RETIRED_PROVIDER_ALIASES[requestedName]
    : requestedName;
  // Availability first: switching a dev-gated provider's option off takes
  // effect on the next lookup, even for an already-initialized instance.
  if (!providerAvailable(name)) return undefined;
  const cached = providers.get(name);
  if (cached) return cached;
  // OAuth lazy registration. Covers a load whose credential probe could not
  // answer (credential file mid-write, lock contention, a transient parse
  // failure, or a secrets-less load that never probed): the entry was not
  // enabled, so nothing registered it. Re-probe the credential on each miss
  // and register the instance on the spot. A provider a stored decision
  // turned off is never resurrected here.
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
  return normalized ? !isInclusiveProvider(normalized) : false;
}
/**
 * Whether the named provider takes a PDF as a native document block (its
 * adapter class declares `nativePdf`). A pure lookup, like
 * providerInputExcludesCache: it never instantiates a provider, and an unknown
 * provider is treated as native.
 */
export function providerNativePdf(name) {
  return providerTakesNativePdf(providers.get(String(name || '').toLowerCase()));
}
/**
 * Whether the named provider sends image input to its models: false only for
 * an adapter that declares `takesImages = false` (the text-only local
 * runtime, which lowers every image to a placeholder). A pure lookup; an
 * unknown provider is treated as taking images, as attachments are.
 */
export function providerReadsImages(name) {
  return providers.get(String(name || '').toLowerCase())?.takesImages !== false;
}
/**
 * The user's image-input override for one model of a custom provider: true or
 * false as set, undefined when unset (auto) or the provider is not a loaded
 * custom one. A pure lookup; it never instantiates a provider.
 */
export function providerModelVisionOverride(name, model) {
  const overrides = providers.get(String(name || '').toLowerCase())?.customConfig?.modelOverrides;
  const value = overrides && Object.hasOwn(overrides, model) ? overrides[model]?.supportsVision : undefined;
  return typeof value === 'boolean' ? value : undefined;
}
/**
 * Whether the named provider's adapter declares `consumesReadWindows`: it
 * needs the structured clip report of read results. A pure lookup; a proxy
 * stand-in carries the PC adapter's declared trait.
 */
export function providerConsumesReadWindows(name) {
  return providers.get(String(name || '').toLowerCase())?.consumesReadWindows === true;
}
export function getAllProviders() {
  // Defensive copy — callers must not mutate the live registry or retain
  // stale entries across re-init (initProviders rebuilds the map in place).
  return new Map(availableProviderEntries());
}

// Live instances minus dev-gated providers whose Developer option is off.
function availableProviderEntries() {
  return [...providers].filter(([name]) => providerAvailable(name));
}

export function disableProvider(name) {
  const id = String(name || '').trim();
  if (!id) return false;
  _explicitlyDisabled.add(id);
  return removeProvider(id);
}

export function providerCatalogRevision() {
  return _providerCatalogRevision;
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
// Async variant for callbacks that run a whole turn against the registered
// instance (askSession looks the provider up after its first await).
export async function _withRegisteredProviderForTestAsync(name, instance, fn) {
  const hadProvider = providers.has(name);
  const priorProvider = providers.get(name);
  providers.set(name, instance);
  try {
    return await fn();
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
  if (typeof provider?.listModels === 'function') return (signal) => provider.listModels({ signal });
  return null;
}

// One provider's refresh, bounded per provider (catalog-deadline.mjs): a hung
// or offline provider is reported and left out after the deadline, so the
// refresh epoch still completes for everyone else. Its late answer lands in
// its own model cache; the session catalog retries its listing after the
// partial-catalog backoff.
function boundedCatalogRefresh(name, provider, refreshFn, label) {
  return boundedProviderCatalogOp({ name, provider, kind: 'refresh', run: refreshFn }).then(({ error }) => {
    if (!error) return;
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[provider:${name}] ${label} failed: ${msg}\n`);
  });
}

function armNextCatalogRefresh(startedAt = Date.now()) {
  _catalogRefreshNotBefore = startedAt + CATALOG_REFRESH_INTERVAL_MS;
  if (_catalogRefreshTimer) clearTimeout(_catalogRefreshTimer);
  _catalogRefreshTimer = setTimeout(
    () => {
      _catalogRefreshTimer = null;
      void refreshCatalogs();
    },
    Math.max(1, _catalogRefreshNotBefore - Date.now())
  );
  _catalogRefreshTimer.unref?.();
}

// Whether `name`'s catalog was already fetched for its current config, and
// records that it is now (the caller fetches it).
function claimCatalogRefresh(name) {
  const sig = signatures.get(name) ?? null;
  if (_catalogRefreshedSigs.has(name) && _catalogRefreshedSigs.get(name) === sig) return false;
  _catalogRefreshedSigs.set(name, sig);
  return true;
}

// Force-refresh each provider's /models catalog once per boot: a provider is
// fetched when it is added or rebuilt from a changed config, never again for
// the same config. Every session runtime joins this process-global promise
// and reads the same provider-instance caches; it changes (a new epoch) only
// when there is a provider to fetch. The next network refresh is armed for 24h
// later; view entry, search, settings, and explicit refresh requests inside
// that window only reuse the completed catalog epoch.
export function refreshProviderCatalogsOnStartup() {
  const pending = [];
  for (const [name, provider] of availableProviderEntries()) {
    if (!claimCatalogRefresh(name)) continue;
    const refreshFn = providerCatalogRefreshFn(provider);
    if (refreshFn) pending.push(boundedCatalogRefresh(name, provider, refreshFn, 'startup catalog refresh'));
  }
  if (!pending.length && _startupCatalogRefreshPromise) return _startupCatalogRefreshPromise;
  if (!_startupCatalogRefreshPromise) armNextCatalogRefresh();
  // A completion promise (joining the epoch before it) so callers can
  // invalidate stale model caches once the fresh catalogs land. Still
  // fire-and-forget: unawaited callers keep the nonblocking startup behavior.
  const prior = _startupCatalogRefreshPromise;
  _startupCatalogRefreshPromise = Promise.allSettled(prior ? [prior, ...pending] : pending).then((results) => {
    _providerCatalogRevision += 1;
    return results;
  });
  return _startupCatalogRefreshPromise;
}

// Force-refresh only the named providers' catalogs, each bounded like the full
// refresh. It leaves the 24h window, the catalog revision and every other
// provider's cache alone.
export function refreshProviderCatalogsFor(names) {
  const pending = [];
  for (const [name, provider] of availableProviderEntries()) {
    const refreshFn = names.includes(name) ? providerCatalogRefreshFn(provider) : null;
    if (refreshFn) pending.push(boundedCatalogRefresh(name, provider, refreshFn, 'catalog refresh'));
  }
  return Promise.allSettled(pending);
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
  // The shared metadata fetch is bounded the same way: providers wait for it
  // at most one deadline before refreshing without fresh metadata.
  const metadataReady = boundedProviderCatalogOp({
    name: '(model-metadata)',
    provider: null,
    kind: 'refresh',
    run: () => refreshMetadataCatalog(),
  }).then(({ error }) => {
    if (!error) return;
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[model-catalog] metadata refresh failed: ${msg}\n`);
  });
  for (const [name, provider] of availableProviderEntries()) {
    // A full refresh fetches every provider for its current config.
    claimCatalogRefresh(name);
    const refreshFn = providerCatalogRefreshFn(provider);
    if (!refreshFn) continue;
    pending.push(metadataReady.then(() => boundedCatalogRefresh(name, provider, refreshFn, 'catalog refresh')));
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
