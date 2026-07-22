import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readSection, updateSection, updateSectionAsync, getAgentApiKey, AGENT_PROVIDER_ENV } from '../../shared/config.mjs';
import { OPENAI_COMPAT_PRESETS } from './providers/openai-compat-presets.mjs';
import {
    hasAnthropicOAuthCredentials,
    hasOpenAIOAuthCredentials,
    hasGrokOAuthCredentials,
} from './providers/oauth-credential-probes.mjs';

// Keep config loading free of standalone provider-admin and its provider
// runtimes. These identifiers mirror that module's static catalog, assembled
// solely from the lightweight config/provider constants already imported here.
const CONFIG_PROVIDER_IDS = new Set([
    ...Object.keys(AGENT_PROVIDER_ENV),
    ...Object.keys(OPENAI_COMPAT_PRESETS),
    'openai-oauth',
    'anthropic-oauth',
    'grok-oauth',
]);
function isConfiguredProviderId(provider) {
    return CONFIG_PROVIDER_IDS.has(String(provider || '').trim());
}

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
// Explore and Maintainer start without a route so they dynamically inherit the
// Main route. Explicit `maintenance.explore` / `maintenance.memory` choices
// remain supported. The memory cycles (chunker / re-scorer / core reviewer)
// share the optional `memory` preset knob — the cycle agents stay separate
// (cycle1/2/3-agent, distinct slots and invokedBy) but resolve their model from
// `maint.memory` via the `maintKey` override on their hidden-role entries.
// scheduler/webhook still let a per-entry config.json model win first (the
// caller passes it explicitly via opts.preset); the haiku default below only
// applies when an entry omits its own model.
// Slots surfaced as tunable rows in the Maintenance Setup panel. This is the
// UI / allow-list view (GET cleanup + POST validation) and is intentionally a
// SUBSET of DEFAULT_MAINTENANCE: scheduler/webhook carry a per-entry model and
// are not shown as shared rows, but still inherit the haiku default above when
// an entry omits its own model.
export const MAINTENANCE_SLOTS = Object.freeze(['explore', 'memory']);

// --- User profile (statusline /profile) -------------------------------------
// Supported response languages for the /profile picker. `system` is the default
// sentinel: it leaves the language unset so the model follows the user's locale
// / written language (no forced "Always respond in X" injection). Each entry is
// { id, label, prompt } — `prompt` is the human language name the prompt-side
// wiring uses for "Always respond in <prompt>." Keep `system` first.
export const PROFILE_LANGUAGES = Object.freeze([
    { id: 'system', label: 'System (locale)', prompt: null },
    { id: 'en', label: 'English', prompt: 'English' },
    { id: 'ko', label: 'Korean', prompt: 'Korean' },
    { id: 'ja', label: '日本語', prompt: 'Japanese (日本語)' },
    { id: 'zh-Hans', label: '中文（简体）', prompt: 'Simplified Chinese (简体中文)' },
    { id: 'zh-Hant', label: '中文（繁體）', prompt: 'Traditional Chinese (繁體中文)' },
    { id: 'es', label: 'Español', prompt: 'Spanish (Español)' },
    { id: 'fr', label: 'Français', prompt: 'French (Français)' },
    { id: 'de', label: 'Deutsch', prompt: 'German (Deutsch)' },
    { id: 'pt', label: 'Português', prompt: 'Portuguese (Português)' },
    { id: 'ru', label: 'Русский', prompt: 'Russian (Русский)' },
    { id: 'it', label: 'Italiano', prompt: 'Italian (Italiano)' },
    { id: 'vi', label: 'Tiếng Việt', prompt: 'Vietnamese (Tiếng Việt)' },
    { id: 'th', label: 'ภาษาไทย', prompt: 'Thai (ภาษาไทย)' },
    { id: 'id', label: 'Bahasa Indonesia', prompt: 'Indonesian (Bahasa Indonesia)' },
    { id: 'hi', label: 'हिन्दी', prompt: 'Hindi (हिन्दी)' },
    { id: 'ar', label: 'العربية', prompt: 'Arabic (العربية)' },
    { id: 'tr', label: 'Türkçe', prompt: 'Turkish (Türkçe)' },
    { id: 'pl', label: 'Polski', prompt: 'Polish (Polski)' },
    { id: 'nl', label: 'Nederlands', prompt: 'Dutch (Nederlands)' },
    { id: 'uk', label: 'Українська', prompt: 'Ukrainian (Українська)' },
]);

const PROFILE_LANGUAGE_IDS = new Set(PROFILE_LANGUAGES.map((lang) => lang.id));
const PROFILE_TITLE_MAX = 64;

// Resolve a stored profile (or raw config fragment) into a stable shape:
//   { title: string, language: <valid id> }
// Unknown language ids fall back to 'system'; titles are trimmed/capped.
export function normalizeProfileConfig(value = {}) {
    const raw = value && typeof value === 'object' ? value : {};
    const title = String(raw.title ?? raw.name ?? '').trim().slice(0, PROFILE_TITLE_MAX);
    const requested = String(raw.language ?? raw.lang ?? 'system').trim();
    const language = PROFILE_LANGUAGE_IDS.has(requested) ? requested : 'system';
    return { title, language };
}

/** Persisted `skills.disabled` name list (deduped, trimmed, sorted). */
export function normalizeSkillsConfig(value = {}) {
    const raw = value && typeof value === 'object' ? value : {};
    const disabled = Array.isArray(raw.disabled)
        ? [...new Set(raw.disabled.map((n) => String(n).trim()).filter(Boolean))]
        : [];
    disabled.sort((a, b) => a.localeCompare(b));
    return { disabled };
}

// Look up the catalog entry for a stored language id (defaults to 'system').
export function profileLanguageEntry(languageId) {
    const id = String(languageId || 'system');
    return PROFILE_LANGUAGES.find((lang) => lang.id === id) || PROFILE_LANGUAGES[0];
}

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

// Canonical maintenance defaults. Single source of truth — imported by
// llm/index.mjs and setup-server.mjs so UI/runtime cannot drift from config.
//
// Each maintenance slot stores its model route DIRECTLY ({provider, model}) —
// parity with `agents.<role>`. The old shape stored a preset NAME string (e.g.
// "haiku") that had to be looked up in the config.presets array; that
// indirection resolves at dispatch. agent-dispatch.resolveMaintenanceRoute
// accepts a preset NAME (Main inheritance via config.default), and
// these defaults use the direct route. loadConfig() normalizes stored
// slots on read (see normalizeMaintenanceRoutes). The cycle1/2/3 memory
// agents share ONE `memory` route via the `maintKey: 'memory'` override on
// their hidden-role entries.
const _HAIKU_ROUTE = Object.freeze({
    provider: 'anthropic-oauth',
    model: resolveAnthropicFamilyModel('haiku'),
});
export const DEFAULT_MAINTENANCE = Object.freeze({
    scheduler: { ..._HAIKU_ROUTE },
    webhook: { ..._HAIKU_ROUTE },
});

// Seed presets keyed by preset.name so workflow/maintenance references stay
// consistent with the resolve-by-name lookup in presetKey().
export const DEFAULT_PRESETS = Object.freeze([
    Object.freeze({ id: 'haiku', name: 'HAIKU', type: 'agent', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('haiku'), tools: 'full' }),
    Object.freeze({ id: 'sonnet-mid', name: 'SONNET MID', type: 'agent', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'sonnet-high', name: 'SONNET HIGH', type: 'agent', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('sonnet'), effort: 'high', tools: 'full' }),
    Object.freeze({ id: 'opus-mid', name: 'OPUS MID', type: 'agent', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'medium', tools: 'full' }),
    Object.freeze({ id: 'opus-high', name: 'OPUS HIGH', type: 'agent', provider: 'anthropic-oauth', model: resolveAnthropicFamilyModel('opus'), effort: 'high', tools: 'full' }),
]);
function buildDefaultConfig(options = {}) {
    const detectCredentials = options.detectCredentials !== false;
    const providers = {};
    // API providers — enabled if env key exists
    for (const [name, envKey] of Object.entries(AGENT_PROVIDER_ENV)) {
        const apiKey = detectCredentials ? process.env[envKey] : undefined;
        providers[name] = {
            enabled: !!apiKey,
            apiKey: apiKey || undefined,
        };
    }
    // OAuth provider detection uses lightweight credential probes so config
    // load does not import provider runtimes or SDKs. WebSocket transport is on by default —
    // measured ~96% cross-session cache hit with delta payloads. Users who
    // need to force SSE (e.g. a corporate proxy blocking WSS) can set
    // `websocket: false` in mixdog-config.json (agent.providers.openai-oauth).
    providers['openai-oauth'] = { enabled: detectCredentials ? hasOpenAIOAuthCredentials() : false, websocket: true };
    providers['anthropic-oauth'] = { enabled: detectCredentials ? hasAnthropicOAuthCredentials() : false };
    // Grok OAuth ("Grok Build"). Like the other OAuth entries it is not
    // stored in mixdog-config.json — enabled at runtime from the presence of
    // Mixdog-owned credentials.
    providers['grok-oauth'] = { enabled: detectCredentials ? hasGrokOAuthCredentials() : false };
    // Local providers — opt-in via setup UI after HTTP ping confirms server is running
    providers.ollama = { enabled: false, baseURL: 'http://localhost:11434/v1' };
    providers.lmstudio = { enabled: false, baseURL: 'http://localhost:1234/v1' };
    return { providers, workflow: { active: 'default' } };
}

function hasKeys(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

// Process-local write intent for project MCP overrides. A loaded config contains
// snapshots for every project, but only entries toggled by this process may
// override a newer value read from disk inside the save lock.
const dirtyMcpProjectOverrides = new Map();
let mcpProjectOverrideDirtySeq = 0;
function mcpProjectOverrideDirtyKey(projectKey, serverName) {
    return `${String(projectKey)}\u0000${String(serverName)}`;
}
export function markMcpProjectOverrideDirty(projectKey, serverName, enabled) {
    const pairKey = mcpProjectOverrideDirtyKey(projectKey, serverName);
    dirtyMcpProjectOverrides.set(pairKey, {
        enabled: enabled !== false,
        seq: ++mcpProjectOverrideDirtySeq,
    });
}
function clearDurablySavedMcpProjectOverrides(appliedDirty) {
    for (const { pairKey, seq } of appliedDirty) {
        if (dirtyMcpProjectOverrides.get(pairKey)?.seq === seq) {
            dirtyMcpProjectOverrides.delete(pairKey);
        }
    }
}

function normalizeSearchRoute(route) {
    if (!route || typeof route !== 'object' || Array.isArray(route))
        return null;
    const provider = normalizeAgentProviderId(route.provider);
    const model = String(route.model || '').trim();
    if (!provider || !model)
        return null;
    const out = { provider, model };
    const effort = String(route.effort || '').trim();
    if (effort)
        out.effort = effort;
    if (route.fast === true)
        out.fast = true;
    const toolType = String(route.toolType || '').trim();
    if (toolType)
        out.toolType = toolType;
    return out;
}

// Normalize stored maintenance slots to the direct {provider, model} route
// shape (provider/model/effort/fast only). Non-route values are dropped so the
// DEFAULT_MAINTENANCE route fills the slot.
function normalizeMaintenanceRoutes(rawMaint, defaultProvider) {
    const out = {};
    const configuredProvider = String(defaultProvider || '').trim();
    const fallbackProvider = isConfiguredProviderId(configuredProvider)
        ? configuredProvider
        : 'anthropic-oauth';
    for (const [slot, value] of Object.entries(rawMaint || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const provider = normalizeAgentProviderId(
                value.provider || ((slot === 'explore' || slot === 'memory') ? fallbackProvider : ''),
            );
            const model = String(value.model || '').trim();
            if (provider && model) {
                const route = { provider, model };
                const effort = String(value.effort || '').trim();
                if (effort) route.effort = effort;
                if (value.fast === true) route.fast = true;
                out[slot] = route;
            }
            continue;
        }
    }
    return out;
}

// Persist the agent section. `build` receives the section value read INSIDE
// the file lock (current on-disk state) and returns the full replacement.
// Building from `current` rather than a snapshot taken before the lock keeps
// the whole-section save linearizable: a concurrent writer (each host-agent
// session runs its own server under MIXDOG_MULTI_INSTANCE) that lands between
// our read and write is rebased onto, not silently clobbered (lost-update).
function persistAgentConfig(build) {
    updateSection('agent', (current) => build(hasKeys(current) ? current : {}));
}

// Async twin of persistAgentConfig: same in-lock rebase-on-current semantics,
// but the whole-section RMW runs through updateSectionAsync so a debounced
// timer flush never blocks the event loop on icacls/backup. Reuses the same
// config lock file, so it stays linearizable with the sync writers.
async function persistAgentConfigAsync(build) {
    await updateSectionAsync('agent', (current) => build(hasKeys(current) ? current : {}));
}

// Recap toggle (recap.enabled, default true) gates ONLY the background memory
// cycles. The memory module itself is always-on.
function normalizeRecapConfig(rawRecap) {
    const recap = rawRecap && typeof rawRecap === 'object' ? { ...rawRecap } : {};
    recap.enabled = recap.enabled !== false;
    return recap;
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

            // Self-ref guard: mcpServers.mixdog / mcpServers["trib-plugin"]
            // would self-spawn through the in-process tool adapter. Strip on
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
            const recapConfig = normalizeRecapConfig(raw.recap);

            const rawPresets = Array.isArray(raw.presets) ? raw.presets : [];
            const normalizedPresets = rawPresets
                .map(p => normalizePreset(p))
                .filter(Boolean)
                .filter(p => p.id !== 'workflow-search');
            const workflowRoutes = raw.workflowRoutes && typeof raw.workflowRoutes === 'object' ? { ...raw.workflowRoutes } : {};
            delete workflowRoutes.search;
            // Normalize maintenance slots to routes, then overlay onto the
            // route-shaped defaults.
            const normalizedMaint = normalizeMaintenanceRoutes(rawMaint, raw.defaultProvider);
            return {
                providers: mergedProviders,
                mcpServers,
                mcpProjectOverrides: raw.mcpProjectOverrides && typeof raw.mcpProjectOverrides === 'object' && !Array.isArray(raw.mcpProjectOverrides)
                    ? raw.mcpProjectOverrides
                    : {},
                presets: normalizedPresets,
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...normalizedMaint },
                workflowRoutes,
                searchRoute: normalizeSearchRoute(raw.searchRoute),
                fastModels: raw.fastModels && typeof raw.fastModels === 'object' ? raw.fastModels : {},
                modelSettings: raw.modelSettings && typeof raw.modelSettings === 'object' ? raw.modelSettings : {},
                onboarding: raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {},
                agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {},
                workflow: raw.workflow && typeof raw.workflow === 'object' ? { active: String(raw.workflow.active || 'default') } : { active: 'default' },
                agentMaintenance: { enabled: true, interval: '1h', ...raw.agentMaintenance },
                profile: normalizeProfileConfig(raw.profile),
                skills: normalizeSkillsConfig(raw.skills),
                // No idleMs default here: absent idleMs means "provider default"
                // (config-helpers normalizeAutoClearConfig custom:false path).
                // Injecting a fixed 1h would mark every config custom:true and
                // bypass the per-provider auto-clear table.
                autoClear: { enabled: true, ...raw.autoClear },
                compaction: raw.compaction && typeof raw.compaction === 'object' ? { ...raw.compaction } : {},
                trajectory: { enabled: true, ...raw.trajectory },
                runtime: raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {},
                shell: raw.shell && typeof raw.shell === 'object' ? raw.shell : {},
                update: raw.update && typeof raw.update === 'object' ? { ...raw.update } : {},
                recap: recapConfig,
                modules: raw.modules && typeof raw.modules === 'object' ? { ...raw.modules } : {},
            };
        }
        catch { /* fall through */ }
    }
    const defaults = buildDefaultConfig({ detectCredentials: includeSecrets });
    return {
        ...defaults,
        mcpServers: {},
        mcpProjectOverrides: {},
        presets: DEFAULT_PRESETS.map(p => ({ ...p })),
        default: null,
        maintenance: { ...DEFAULT_MAINTENANCE },
        workflowRoutes: {},
        searchRoute: null,
        fastModels: {},
        modelSettings: {},
        onboarding: {},
        agents: {},
        workflow: { active: 'default' },
        agentMaintenance: { enabled: true, interval: '1h' },
        profile: normalizeProfileConfig(null),
        skills: normalizeSkillsConfig(null),
                autoClear: { enabled: true },
        compaction: {},
        trajectory: { enabled: true },
        runtime: {},
        shell: {},
        update: {},
        recap: { enabled: true },
        modules: {},
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
 * via persistAgentConfig((current) => ({ ...current, <field> })) so a
 * concurrent instance's edits are not reverted.
 */
/** In-lock patch of `skills.disabled` only (avoids whole-config lost-update). */
function buildSkillsDisabledPatch(disabledNames) {
    const names = disabledNames instanceof Set
        ? [...disabledNames]
        : (Array.isArray(disabledNames) ? disabledNames : []);
    const nextSkills = normalizeSkillsConfig({ disabled: names });
    const build = (current) => {
        const cur = { ...current };
        const target = (cur.agent && cur.agent.providers)
            ? (cur.agent = { ...cur.agent })
            : cur;
        target.skills = nextSkills;
        return cur;
    };
    return { build, nextSkills };
}
export function patchSkillsDisabled(disabledNames) {
    const { build, nextSkills } = buildSkillsDisabledPatch(disabledNames);
    persistAgentConfig(build);
    return nextSkills;
}
// Async twin used by the debounced skills flush timer.
export async function patchSkillsDisabledAsync(disabledNames) {
    const { build, nextSkills } = buildSkillsDisabledPatch(disabledNames);
    await persistAgentConfigAsync(build);
    return nextSkills;
}

function buildAgentSaveBuilder(config, appliedDirty) {
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
    return (existingRaw) => {
        const mcpServers = config.mcpServers || {};
        const diskOverrides = existingRaw.mcpProjectOverrides && typeof existingRaw.mcpProjectOverrides === 'object'
            ? existingRaw.mcpProjectOverrides
            : {};
        const memoryOverrides = config.mcpProjectOverrides && typeof config.mcpProjectOverrides === 'object'
            ? config.mcpProjectOverrides
            : {};
        const mcpProjectOverrides = {};
        for (const projectKey of new Set([...Object.keys(diskOverrides), ...Object.keys(memoryOverrides)])) {
            const diskProject = diskOverrides[projectKey] && typeof diskOverrides[projectKey] === 'object'
                ? diskOverrides[projectKey]
                : {};
            const memoryProject = memoryOverrides[projectKey] && typeof memoryOverrides[projectKey] === 'object'
                ? memoryOverrides[projectKey]
                : {};
            // Disk wins for untouched snapshot entries. Only an override this
            // process explicitly toggled may replace the in-lock disk value.
            const mergedProject = { ...memoryProject, ...diskProject };
            for (const serverName of Object.keys(memoryProject)) {
                const pairKey = mcpProjectOverrideDirtyKey(projectKey, serverName);
                const dirty = dirtyMcpProjectOverrides.get(pairKey);
                if (dirty) {
                    const appliedValue = { enabled: dirty.enabled };
                    mergedProject[serverName] = appliedValue;
                    appliedDirty.push({ pairKey, seq: dirty.seq, appliedValue });
                }
            }
            for (const serverName of Object.keys(mergedProject)) {
                if (!Object.prototype.hasOwnProperty.call(mcpServers, serverName)) delete mergedProject[serverName];
            }
            if (Object.keys(mergedProject).length > 0) mcpProjectOverrides[projectKey] = mergedProject;
        }
        return {
            ...existingRaw,
            guide: config.guide || existingRaw.guide || undefined,
            providers: persistedProviders,
            mcpServers,
            mcpProjectOverrides,
            presets,
            default: config.default || null,
            maintenance: config.maintenance || {},
            workflowRoutes,
            searchRoute: normalizeSearchRoute(config.searchRoute),
            fastModels: config.fastModels || {},
            modelSettings: config.modelSettings || {},
            onboarding: config.onboarding || {},
            agents: config.agents || {},
            workflow: config.workflow || { active: 'default' },
            agentMaintenance: config.agentMaintenance || {},
            profile: normalizeProfileConfig(config.profile),
            skills: normalizeSkillsConfig(config.skills),
            autoClear: config.autoClear || {},
            compaction: config.compaction || {},
            trajectory: config.trajectory || {},
            runtime: config.runtime || {},
            shell: config.shell || {},
            update: config.update || {},
            recap: config.recap || {},
            modules: config.modules || existingRaw.modules || {},
        };
    };
}
export function saveConfig(config) {
    const appliedDirty = [];
    persistAgentConfig(buildAgentSaveBuilder(config, appliedDirty));
    clearDurablySavedMcpProjectOverrides(appliedDirty);
}
// Async twin used by the debounced config-save flush timer.
export async function saveConfigAsync(config) {
    const appliedDirty = [];
    await persistAgentConfigAsync(buildAgentSaveBuilder(config, appliedDirty));
    clearDurablySavedMcpProjectOverrides(appliedDirty);
}
// --- Preset helpers ---
// preset shape: { id, name, type: 'agent', provider, model, effort?, fast?, tools? }
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
    const out = { id, name, type: 'agent', provider, model };
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
// one Agent session, so opus-mid / opus-max no longer fragment the pool.
//
//   agent lane: "agent:<agentId>:<provider>:<model>"  — per Sub role
//   other lane: "agent:<provider>:<model>"            — shared utility
export function resolveRuntimeSpec(preset, ctx) {
    const lane = ctx.lane || 'agent';
    const provider = String(preset?.provider || '').trim() || 'unknown';
    const model = String(preset?.model || '').trim() || '_';
    let scopeKey;
    if (lane === 'agent') {
        if (!ctx.agentId) throw new Error('agent lane requires agentId');
        scopeKey = `agent:${ctx.agentId}:${provider}:${model}`;
    } else {
        scopeKey = `agent:${provider}:${model}`;
    }
    return { lane, scopeKey, reuse: true, preset };
}
