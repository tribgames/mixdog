import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readSection, updateSection, getAgentApiKey, AGENT_PROVIDER_ENV } from '../../shared/config.mjs';
import { OPENAI_COMPAT_PRESETS } from './providers/openai-compat.mjs';
import { hasAnthropicOAuthCredentials } from './providers/anthropic-oauth.mjs';
import { hasOpenAIOAuthCredentials } from './providers/openai-oauth.mjs';
import { hasGrokOAuthCredentials } from './providers/grok-oauth.mjs';

// Thin wrapper around resolvePluginData so callers in this orchestrator tree
// can import a single helper without reaching into shared/.
export function getPluginData() {
    return resolvePluginData();
}
// First-class agent API-key providers: imported from the shared SSOT
// (src/shared/config.mjs) so default-config and overlay paths cannot drift
// from the env names the runtime key loader (getAgentApiKey) actually uses.
// Canonical maintenance defaults. Single source of truth — imported by
// llm/index.mjs and setup-server.mjs so UI/runtime cannot drift from config.
//
// Every hidden maintenance slot carries a CONCRETE preset here, so
// resolvePresetName() (bridge-llm) always resolves a model directly from
// `maint[slot]` — no shared `defaultPreset` fallback is needed or used.
// Memory cycles + Lead helper fan-out (explore/cycle1/cycle2/cycle3) and
// entry-driven dispatch (scheduler/webhook) all default to `haiku`. The three
// memory cycles (chunker / re-scorer / core reviewer) share ONE `memory`
// preset knob — the cycle agents stay separate (cycle1/2/3-agent, distinct
// slots and invokedBy) but resolve their model from `maint.memory` via the
// `maintKey` override on their hidden-role entries.
// scheduler/webhook still let a per-entry config.json model win first (the
// caller passes it explicitly via opts.preset); the haiku default below only
// applies when an entry omits its own model.
export const DEFAULT_MAINTENANCE = Object.freeze({
    explore: 'haiku',
    memory: 'haiku',
    scheduler: 'haiku',
    webhook: 'haiku',
});

// Slots surfaced as tunable rows in the Maintenance Setup panel. This is the
// UI / allow-list view (GET cleanup + POST validation) and is intentionally a
// SUBSET of DEFAULT_MAINTENANCE: scheduler/webhook carry a per-entry model and
// are not shown as shared rows, but still inherit the haiku default above when
// an entry omits its own model.
export const MAINTENANCE_SLOTS = Object.freeze(['explore', 'memory']);

// Map short Anthropic family labels to the full model ids used by the API.
// Honors ANTHROPIC_DEFAULT_{OPUS|SONNET|HAIKU}_MODEL env overrides.
const ANTHROPIC_FAMILY_MODEL = Object.freeze({
    opus: 'claude-opus-4-8',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
});
function resolveAnthropicFamilyModel(family) {
    const key = String(family || '').toLowerCase();
    if (!key) return null;
    const envVar = `ANTHROPIC_DEFAULT_${key.toUpperCase()}_MODEL`;
    if (process.env[envVar]) return process.env[envVar];
    return ANTHROPIC_FAMILY_MODEL[key] || null;
}

// Seed presets keyed by preset.name so workflow/maintenance references stay
// consistent with the resolve-by-name lookup in presetKey().
export const DEFAULT_PRESETS = Object.freeze([
    Object.freeze({ id: 'haiku', name: 'HAIKU', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('haiku'), tools: 'full' }),
    Object.freeze({ id: 'sonnet-mid', name: 'SONNET MID', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'sonnet-high', name: 'SONNET HIGH', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'high', tools: 'full' }),
    Object.freeze({ id: 'opus-mid', name: 'OPUS MID', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'opus-high', name: 'OPUS HIGH', type: 'bridge', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'high', tools: 'full' }),
]);
function buildDefaultConfig(options = {}) {
    const detectCredentials = options.detectCredentials !== false;
    const providers = {};
    // API providers — enabled if env key exists
    for (const [name, envKey] of Object.entries(AGENT_PROVIDER_ENV)) {
        const apiKey = process.env[envKey];
        providers[name] = {
            enabled: !!apiKey,
            apiKey: apiKey || undefined,
        };
    }
    // OAuth provider detection delegates to each provider module so the
    // canonical credential loader (loadTokens / loadCredentials) is the
    // single source of truth. WebSocket transport is on by default —
    // measured ~96% cross-session cache hit with delta payloads. Users who
    // need to force SSE (e.g. a corporate proxy blocking WSS) can set
    // `websocket: false` in mixdog-config.json (agent.providers.openai-oauth).
    providers['openai-oauth'] = { enabled: detectCredentials ? hasOpenAIOAuthCredentials() : false, websocket: true };
    providers['anthropic-oauth'] = { enabled: detectCredentials ? hasAnthropicOAuthCredentials() : false };
    // Grok CLI OAuth ("Grok Build"). Like the other OAuth entries it is not
    // stored in mixdog-config.json — enabled at runtime from the presence of
    // either token source (own store or ~/.grok/auth.json) via
    // hasGrokOAuthCredentials().
    providers['grok-oauth'] = { enabled: detectCredentials ? hasGrokOAuthCredentials() : false };
    // Local providers — opt-in via setup UI after HTTP ping confirms server is running
    providers.ollama = { enabled: false, baseURL: 'http://localhost:11434/v1' };
    providers.lmstudio = { enabled: false, baseURL: 'http://localhost:1234/v1' };
    return { providers, workflow: { active: 'default' } };
}

function hasKeys(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

// Persist the agent section. `build` receives the section value read INSIDE
// the file lock (current on-disk state) and returns the full replacement.
// Building from `current` rather than a snapshot taken before the lock keeps
// the whole-section save linearizable: a concurrent writer (each Claude Code
// session runs its own server under MIXDOG_MULTI_INSTANCE) that lands between
// our read and write is rebased onto, not silently clobbered (lost-update).
function persistAgentConfig(build) {
    updateSection('agent', (current) => build(hasKeys(current) ? current : {}));
}

export function loadConfig(options = {}) {
    const includeSecrets = options.secrets !== false;
    const sectionRaw = readSection('agent');
    if (hasKeys(sectionRaw)) {
        try {
            let raw = sectionRaw;
            if (raw.agent && raw.agent.providers) {
                raw = raw.agent;
            }
            const defaults = buildDefaultConfig({ detectCredentials: includeSecrets });
            // Deep-merge provider subkeys: unknown per-provider values are
            // preserved through save/load so future fields round-trip
            // without schema updates here.
            const mergedProviders = { ...defaults.providers };
            if (raw.providers && typeof raw.providers === 'object') {
                for (const [name, val] of Object.entries(raw.providers)) {
                    if (val && typeof val === 'object') {
                        mergedProviders[name] = { ...(mergedProviders[name] || {}), ...val };
                    } else {
                        mergedProviders[name] = val;
                    }
                }
            }
            // Provider API keys live in the OS keychain (std env / MIXDOG_AGENT_*
            // -> keychain), never plaintext in config. Overlay them so the
            // provider clients see config.apiKey populated.
            // AGENT_PROVIDER_ENV covers first-class key providers; OPENAI_COMPAT_PRESETS
            // covers compat providers (opencode-go, …) whose key also lives in
            // the keychain. Without the union, a compat provider with a valid
            // stored key still ships 'no-key' → 401.
            if (includeSecrets) {
                for (const name of new Set([...Object.keys(AGENT_PROVIDER_ENV), ...Object.keys(OPENAI_COMPAT_PRESETS)])) {
                    const kc = getAgentApiKey(name);
                    if (kc) mergedProviders[name] = { ...(mergedProviders[name] || {}), apiKey: kc, enabled: true };
                }
            }
            // Drop unknown maintenance keys (e.g. truly legacy slot names from
            // pre-removal installs). Every valid slot — incl. scheduler/webhook —
            // lives in DEFAULT_MAINTENANCE, so the allow-list below is the single
            // ingress gate and unknown keys are dropped here.
            const allowedMaintKeys = new Set([...Object.keys(DEFAULT_MAINTENANCE), ...MAINTENANCE_SLOTS]);
            const rawMaint = {};
            for (const [k, v] of Object.entries(raw.maintenance || {})) {
                if (allowedMaintKeys.has(k)) rawMaint[k] = v;
            }
            // One-time schema migration: the three memory-cycle MODEL presets
            // (cycle1/cycle2/cycle3) collapsed into a single `memory` key. If the
            // stored config still carries any old cycle key and no `memory`, fold
            // the first present value into `memory` (preserving the user's
            // choice), then the old keys drop via the allow-list above. This is a
            // schema migration, NOT a runtime fallback — the persisted config is
            // cleaned once so runtime never has to re-migrate.
            const legacyCycleKeys = ['cycle1', 'cycle2', 'cycle3'];
            let migratedMaintenance = false;
            if (!('memory' in rawMaint) && legacyCycleKeys.some(k => k in (raw.maintenance || {}))) {
                rawMaint.memory = raw.maintenance.cycle1 ?? raw.maintenance.cycle2 ?? raw.maintenance.cycle3 ?? DEFAULT_MAINTENANCE.memory;
                migratedMaintenance = true;
            }
            // Self-ref guard: mcpServers.mixdog / mcpServers["trib-plugin"]
            // would self-spawn through the in-process tool bridge. Strip on
            // ingress so user-edited configs cannot brick the agent boot.
            const mcpServers = (raw.mcpServers && typeof raw.mcpServers === 'object') ? { ...raw.mcpServers } : {};
            if (mcpServers['mixdog'] || mcpServers['trib-plugin']) {
                delete mcpServers['mixdog'];
                delete mcpServers['trib-plugin'];
                raw.mcpServers = mcpServers;
                try {
                    // Rebase the self-ref strip onto the in-lock current so a
                    // concurrent writer's unrelated edits are not reverted by
                    // this read-time sanitize.
                    persistAgentConfig((current) => {
                        const cur = { ...current };
                        // Strip self-refs at the same level loadConfig reads
                        // mcpServers from: the legacy nested shape keeps them
                        // under cur.agent, the flat shape at top level. Cleaning
                        // only the top level would leave a nested config dirty
                        // on disk even though runtime is sanitized.
                        const target = (cur.agent && cur.agent.providers)
                            ? (cur.agent = { ...cur.agent })
                            : cur;
                        const curMcp = (target.mcpServers && typeof target.mcpServers === 'object') ? { ...target.mcpServers } : {};
                        delete curMcp['mixdog'];
                        delete curMcp['trib-plugin'];
                        target.mcpServers = curMcp;
                        return cur;
                    });
                } catch (err) {
                    process.stderr.write(`[config] persist sanitized config failed: ${err?.message}\n`);
                }
            }
            // Persist the memory-cycle schema migration once. rawMaint already
            // carries the folded `memory` key and excludes the dropped cycle1/2/3
            // keys (not in the allow-list); rebase onto the in-lock current so a
            // concurrent writer's unrelated edits survive, mirroring the
            // mcpServers self-ref strip above.
            if (migratedMaintenance) {
                try {
                    persistAgentConfig((current) => {
                        const cur = { ...current };
                        const target = (cur.agent && cur.agent.providers)
                            ? (cur.agent = { ...cur.agent })
                            : cur;
                        const curMaint = (target.maintenance && typeof target.maintenance === 'object') ? { ...target.maintenance } : {};
                        // Derive `memory` from the IN-LOCK current, not the
                        // pre-lock rawMaint snapshot — a concurrent writer may
                        // have set maintenance.memory or changed a legacy cycle
                        // value between this loadConfig()'s read and the lock.
                        // If `memory` is already present in-lock, preserve it
                        // (lost-update guard); otherwise fold the in-lock legacy
                        // cycle value first, with the pre-lock snapshot as the
                        // last-resort seed.
                        if (!('memory' in curMaint)) {
                            curMaint.memory = curMaint.cycle1 ?? curMaint.cycle2 ?? curMaint.cycle3 ?? rawMaint.memory;
                        }
                        for (const k of legacyCycleKeys) delete curMaint[k];
                        target.maintenance = curMaint;
                        return cur;
                    });
                } catch (err) {
                    process.stderr.write(`[config] persist maintenance migration failed: ${err?.message}\n`);
                }
            }
            const rawPresets = Array.isArray(raw.presets) ? raw.presets : [];
            const normalizedPresets = rawPresets
                .map(p => normalizePreset(p))
                .filter(Boolean)
                .filter(p => p.id !== 'workflow-search');
            const workflowRoutes = raw.workflowRoutes && typeof raw.workflowRoutes === 'object' ? { ...raw.workflowRoutes } : {};
            delete workflowRoutes.search;
            return {
                providers: mergedProviders,
                mcpServers,
                presets: normalizedPresets,
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...rawMaint },
                workflowRoutes,
                fastModels: raw.fastModels && typeof raw.fastModels === 'object' ? raw.fastModels : {},
                modelSettings: raw.modelSettings && typeof raw.modelSettings === 'object' ? raw.modelSettings : {},
                onboarding: raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {},
                agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {},
                workflow: raw.workflow && typeof raw.workflow === 'object' ? { active: String(raw.workflow.active || 'default') } : { active: 'default' },
                agentMaintenance: { enabled: true, interval: '1h', ...raw.agentMaintenance },
                autoClear: { enabled: true, idleMs: 60 * 60 * 1000, ...raw.autoClear },
                trajectory: { enabled: true, ...raw.trajectory },
                bridge: raw.bridge && typeof raw.bridge === 'object' ? raw.bridge : {},
                shell: raw.shell && typeof raw.shell === 'object' ? raw.shell : {},
            };
        }
        catch { /* fall through */ }
    }
    const defaults = buildDefaultConfig({ detectCredentials: includeSecrets });
    return {
        ...defaults,
        mcpServers: {},
        presets: DEFAULT_PRESETS.map(p => ({ ...p })),
        default: null,
        maintenance: { ...DEFAULT_MAINTENANCE },
        workflowRoutes: {},
        fastModels: {},
        modelSettings: {},
        onboarding: {},
        agents: {},
        workflow: { active: 'default' },
        agentMaintenance: { enabled: true, interval: '1h' },
        autoClear: { enabled: true, idleMs: 60 * 60 * 1000 },
        trajectory: { enabled: true },
        bridge: {},
        shell: {},
    };
}
/**
 * Atomically save the agent section in mixdog-config.json. Caller passes the
 * full config object. Only persists mcpServers, presets, default, workflow
 * routing/onboarding, and user-set provider entries (enabled, baseURL) —
 * defaults are recomputed on next load.
 * apiKey is NEVER persisted: provider keys live only in the OS keychain, and
 * loadConfig overlays them into memory, so they must be stripped on save or
 * they would leak back into mixdog-config.json as plaintext.
 *
 * WARNING: whole-section overwrite. Managed fields (presets/default/mcpServers/
 * maintenance/...) are replaced from the passed snapshot (last-writer-wins);
 * only unmanaged keys are rebased on the in-lock current. Safe only for a
 * caller holding a fresh full config. For a single-field change, patch in-lock
 * via persistAgentConfig((current) => ({ ...current, <field> })) — see
 * setDefaultPreset — so a concurrent instance's edits are not reverted.
 */
export function saveConfig(config) {
    // Strip ephemeral defaults from providers but preserve any unknown
    // per-provider subkey so future schema additions round-trip through the
    // setup UI without changes here. apiKey is intentionally omitted —
    // provider keys are keychain-only (loadConfig overlays them into memory;
    // persisting would leak plaintext back into mixdog-config.json). It stays
    // in KNOWN_PROVIDER_KEYS so the generic passthrough loop also skips it.
    const KNOWN_PROVIDER_KEYS = new Set(['apiKey', 'enabled', 'baseURL']);
    const persistedProviders = {};
    if (config.providers) {
        for (const [name, val] of Object.entries(config.providers)) {
            if (!val || typeof val !== 'object') continue;
            const slim = {};
            if (typeof val.enabled === 'boolean') slim.enabled = val.enabled;
            if (val.baseURL) slim.baseURL = val.baseURL;
            for (const [k, v] of Object.entries(val)) {
                if (KNOWN_PROVIDER_KEYS.has(k)) continue;
                if (v === undefined) continue;
                slim[k] = v;
            }
            if (Object.keys(slim).length)
                persistedProviders[name] = slim;
        }
    }
    const workflowRoutes = config.workflowRoutes && typeof config.workflowRoutes === 'object'
        ? { ...config.workflowRoutes }
        : {};
    delete workflowRoutes.search;
    const presets = Array.isArray(config.presets)
        ? config.presets.filter(p => p?.id !== 'workflow-search')
        : [];
    // Build the replacement from `existingRaw` — the section read INSIDE the
    // file lock — not a snapshot taken before it, so unmanaged keys written by
    // a concurrent instance survive the save (lost-update guard).
    persistAgentConfig((existingRaw) => ({
        ...existingRaw,
        guide: config.guide || existingRaw.guide || undefined,
        providers: persistedProviders,
        mcpServers: config.mcpServers || {},
        presets,
        default: config.default || null,
        maintenance: config.maintenance || {},
        workflowRoutes,
        fastModels: config.fastModels || {},
        modelSettings: config.modelSettings || {},
        onboarding: config.onboarding || {},
        agents: config.agents || {},
        workflow: config.workflow || { active: 'default' },
        agentMaintenance: config.agentMaintenance || {},
        autoClear: config.autoClear || {},
        trajectory: config.trajectory || {},
        bridge: config.bridge || {},
        shell: config.shell || {},
    }));
}
// --- Preset helpers ---
// preset shape: { id, name, type: 'bridge', provider, model, effort?, fast?, tools? }
const AGENT_PROVIDER_ALIASES = Object.freeze({
    'openai-api': 'openai',
    'gemini-api': 'gemini',
    'xai-api': 'xai',
});
const FAST_CAPABLE_PRESET_PROVIDERS = new Set([
    'anthropic',
    'anthropic-oauth',
    'openai',
    'openai-oauth',
]);
function normalizeAgentProviderId(provider) {
    const id = String(provider || '').trim();
    return AGENT_PROVIDER_ALIASES[id] || id;
}
function presetKey(p) { return p?.id || p?.name || ''; }
function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object')
        return null;
    const id = String(preset.id || preset.name || '').trim();
    const name = String(preset.name || preset.id || '').trim();
    const model = String(preset.model || '').trim();
    const provider = normalizeAgentProviderId(preset.provider);
    if (!name || !model || !provider) return null;
    const out = { id, name, type: 'bridge', provider, model };
    if (preset.effort)
        out.effort = String(preset.effort).trim();
    if (preset.fast === true && FAST_CAPABLE_PRESET_PROVIDERS.has(provider))
        out.fast = true;
    out.tools = ['full', 'readonly', 'mcp'].includes(preset.tools) ? preset.tools : 'full';
    return out;
}
export function getPreset(config, key) {
    const presets = Array.isArray(config?.presets) ? config.presets : [];
    if (key == null || key === '')
        return null;
    // Numeric → index
    if (typeof key === 'number' || /^\d+$/.test(String(key))) {
        const idx = Number(key);
        return presets[idx] || null;
    }
    // String → name or id match
    return presets.find(p => p && presetKey(p) === key) || null;
}
export function getDefaultPreset(config) {
    if (!config?.default)
        return null;
    return getPreset(config, config.default);
}
export function listPresets(config) {
    return Array.isArray(config?.presets) ? config.presets : [];
}
// --- Lane-scoped runtime spec ---
// Phase D-2: scopeKey is (role, provider, model), not (role, preset). Spec
// §4.5 calls for "at most one live session per Sub role × provider"; we
// widen provider to (provider, model) because two presets on the same
// provider that differ only in effort/fast should keep sharing a session
// (both cache shards are identical there), while swapping the model itself
// legitimately needs a fresh session (cache shard is model-specific). Two
// presets mapping to the same (provider, model) therefore collapse into
// one Bridge session, so opus-mid / opus-max no longer fragment the pool.
//
//   bridge lane: "bridge:<agentId>:<provider>:<model>"  — per Sub role
//   other lane:  "bridge:<provider>:<model>"            — shared utility
export function resolveRuntimeSpec(preset, ctx) {
    const lane = ctx.lane || 'bridge';
    const provider = String(preset?.provider || '').trim() || 'unknown';
    const model = String(preset?.model || '').trim() || '_';
    let scopeKey;
    if (lane === 'bridge') {
        if (!ctx.agentId) throw new Error('bridge lane requires agentId');
        scopeKey = `bridge:${ctx.agentId}:${provider}:${model}`;
    } else {
        scopeKey = `bridge:${provider}:${model}`;
    }
    return { lane, scopeKey, reuse: true, preset };
}

export function setDefaultPreset(config, key) {
    const preset = getPreset(config, key);
    if (!preset)
        throw new Error(`preset "${key}" not found`);
    const nextDefault = presetKey(preset);
    // Patch only `default` under the file lock. saveConfig(config) would
    // rewrite the whole agent section from this possibly-stale snapshot and
    // could revert a concurrent instance's preset edits; an in-lock single
    // field patch cannot.
    persistAgentConfig((current) => ({ ...current, default: nextDefault }));
    config.default = nextDefault;
    return preset;
}
