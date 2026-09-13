import { resolvePluginData } from '../../shared/plugin-paths.mjs';
import { readSection, updateSection, updateSectionAsync, getAgentApiKey, AGENT_PROVIDER_ENV } from '../../shared/config.mjs';
import { normalizeExtensionScopes } from '../../shared/extension-scopes.mjs';
import {
    DEFAULT_DISABLED_AGENT_IDS,
    canonicalizeAgentRouteStorage,
} from '../../shared/agent-route-config.mjs';
import profileConfig from '../../shared/profile-config.cjs';
import { DEFAULT_MAINTENANCE, DEFAULT_PRESETS, normalizePreset } from './config-presets.mjs';
import {
    agentConfigStorageNeedsMigration,
    canonicalizeAgentStorage,
    canonicalizeBuiltinsStorage,
    canonicalizeModulesStorage,
    normalizeMaintenanceRoutes,
    normalizeSkillsConfig,
    normalizedModelSettings,
    normalizeWebSearchRoute,
    removeRetiredAgentFields,
} from './config-storage.mjs';
import { OPENAI_COMPAT_PRESETS } from './providers/openai-compat-presets.mjs';
import { oauthCredentialProbeState, isOAuthProviderAvailable } from './providers/oauth-credential-probes.mjs';

export const {
    PROFILE_LANGUAGES,
    PROFILE_EXPERIENCE_LEVELS,
    normalizeProfileConfig,
    profileLanguageEntry,
    profileExperienceLevelEntry,
} = profileConfig;
export { DEFAULT_MAINTENANCE, DEFAULT_PRESETS, normalizeSkillsConfig };
export { getPreset, getDefaultPreset, listPresets, resolveRuntimeSpec } from './config-presets.mjs';

// Thin wrapper around resolvePluginData so callers in this orchestrator tree
// can import a single helper without reaching into shared/.
export function getPluginData() {
    return resolvePluginData();
}
// Stored memory routes are normalized into agent routes at ingress.
const MAINTENANCE_SLOTS = Object.freeze(['memory']);

export function buildDefaultConfig(options = {}) {
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
    // load does not import provider runtimes or SDKs.
    //
    // The probe has THREE outcomes and `enabled` is only a boolean, so the
    // third one is carried alongside it: a credential file that EXISTS but
    // could not be read/parsed this instant (lock contention, EACCES, a torn
    // atomic write) yields enabled:false + credentialProbeUnavailable:true.
    // Without that marker the registry cannot tell such a load apart from a
    // real logout/disable and would latch a momentary FS failure as a user
    // opt-out. The marker is ephemeral: loadConfig drops it as soon as the
    // stored config states `enabled` itself, and saveConfig never persists it.
    // A secrets-less load (loadConfig({ secrets: false })) runs no probe at
    // all, which is "not asked" — never "logged out". It therefore carries the
    // same marker as an unreadable credential: without it, saving such a
    // snapshot froze an OAuth provider that had no stored entry yet into a
    // permanent `enabled:false` (the stored value then outranks every later
    // probe), and the provider silently vanished from the model picker until
    // the user signed in again.
    const oauthEntry = (name, extra = {}) => {
        const state = detectCredentials ? oauthCredentialProbeState(name) : 'unprobed';
        const undetermined = state === 'unreadable' || state === 'unprobed';
        return {
            enabled: state === 'present',
            ...(undetermined ? { credentialProbeUnavailable: true } : {}),
            ...extra,
        };
    };
    // WebSocket transport is on by default — measured ~96% cross-session cache
    // hit with delta payloads. Users who need to force SSE (e.g. a corporate
    // proxy blocking WSS) can set `websocket: false` in mixdog-config.json
    // (agent.providers.openai-oauth).
    providers['openai-oauth'] = oauthEntry('openai-oauth', { websocket: true });
    providers['anthropic-oauth'] = oauthEntry('anthropic-oauth');
    // Grok OAuth ("Grok Build"). Like the other OAuth entries it is not
    // stored in mixdog-config.json — enabled at runtime from the presence of
    // Mixdog-owned credentials.
    providers['grok-oauth'] = oauthEntry('grok-oauth');
    // Dev-only providers (MIXDOG_DEV_PROVIDERS): omitted entirely from the
    // default config while the flag is unset so they never surface in settings.
    // Experimental direct Cursor wire provider. It remains disabled unless a
    // Mixdog-owned login or CURSOR_ACCESS_TOKEN is present.
    if (isOAuthProviderAvailable('cursor-oauth')) providers['cursor-oauth'] = oauthEntry('cursor-oauth');
    // Google Antigravity (Cloud Code Assist). Gemini and Claude behind one
    // Google login; enabled only once a login has stored tokens + project.
    if (isOAuthProviderAvailable('antigravity-oauth')) providers['antigravity-oauth'] = oauthEntry('antigravity-oauth');
    // First-party local inference is installed and toggled from Built-in.
    providers['mixdog-local'] = { enabled: false };
    return {
        providers,
        disabledAgents: [...DEFAULT_DISABLED_AGENT_IDS],
        workflow: { active: 'default' },
    };
}

function hasKeys(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
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
            const storageNeedsMigration = agentConfigStorageNeedsMigration(raw);
            raw = canonicalizeAgentStorage(raw);
            const defaults = buildDefaultConfig({ detectCredentials: includeSecrets });
            // Deep-merge provider subkeys: unknown per-provider values are
            // preserved through save/load so future fields round-trip
            // without schema updates here.
            const mergedProviders = { ...defaults.providers };
            if (raw.providers && typeof raw.providers === 'object') {
                for (const [name, val] of Object.entries(raw.providers)) {
                    if (val && typeof val === 'object') {
                        mergedProviders[name] = { ...(mergedProviders[name] || {}), ...val };
                        // A STORED `enabled` is the user's own decision (setup
                        // UI disable / hand edit) and outranks the probe: keep
                        // it authoritative by dropping the probe-availability
                        // marker, so a disable still removes the provider even
                        // while its credential file happens to be unreadable.
                        if (Object.prototype.hasOwnProperty.call(val, 'enabled')) {
                            delete mergedProviders[name].credentialProbeUnavailable;
                        }
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
            // Cursor account access is OAuth-only. The dashboard's "API"
            // meter is a quota bucket on that account, not a separate provider.
            delete mergedProviders['cursor-api'];
            // Drop unknown maintenance keys (e.g. truly legacy slot names from
            // pre-removal installs). Every valid fallback slot lives in
            // DEFAULT_MAINTENANCE, so the allow-list below is the single
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
                        // updateSection already supplies the agent section.
                        const curMcp = (cur.mcpServers && typeof cur.mcpServers === 'object') ? { ...cur.mcpServers } : {};
                        delete curMcp['mixdog'];
                        delete curMcp['trib-plugin'];
                        cur.mcpServers = curMcp;
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
            const modelSettings = normalizedModelSettings(raw);
            const workflowRoutes = raw.workflowRoutes && typeof raw.workflowRoutes === 'object' ? { ...raw.workflowRoutes } : {};
            delete workflowRoutes.search;
            // Normalize maintenance slots to routes, then overlay onto the
            // route-shaped defaults.
            const normalizedMaint = normalizeMaintenanceRoutes(rawMaint);
            const loaded = canonicalizeAgentRouteStorage({
                providers: mergedProviders,
                mcpServers,
                presets: normalizedPresets,
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...normalizedMaint },
                workflowRoutes,
                webSearchRoute: normalizeWebSearchRoute(raw.webSearchRoute),
                modelSettings,
                onboarding: raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {},
                agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {},
                // Explicit "off" roster. canonicalizeAgentRouteStorage normalizes
                // and drops it when empty, so an all-enabled config stays clean.
                disabledAgents: Array.isArray(raw.disabledAgents) ? raw.disabledAgents : [],
                workflow: raw.workflow && typeof raw.workflow === 'object' ? { active: String(raw.workflow.active || 'default') } : { active: 'default' },
                profile: normalizeProfileConfig(raw.profile),
                skills: normalizeSkillsConfig(raw.skills),
                extensionScopes: normalizeExtensionScopes(raw.extensionScopes),
                // No idleMs default here: absent idleMs means "provider default"
                // (config-helpers normalizeAutoClearConfig custom:false path).
                // Injecting a fixed 1h would mark every config custom:true and
                // bypass the per-provider auto-clear table.
                autoClear: { enabled: true, ...raw.autoClear },
                compaction: raw.compaction && typeof raw.compaction === 'object' ? { ...raw.compaction } : {},
                shell: raw.shell && typeof raw.shell === 'object' ? raw.shell : {},
                update: raw.update && typeof raw.update === 'object' ? { ...raw.update } : {},
                recap: recapConfig,
                modules: canonicalizeModulesStorage(raw.modules) || {},
                ...(raw.builtins && typeof raw.builtins === 'object'
                    ? { builtins: canonicalizeBuiltinsStorage(raw.builtins) }
                    : {}),
            });
            if (storageNeedsMigration) {
                try {
                    // Retired cross-section fields are no longer migrated by
                    // the shared config layer. Normalize only the locked
                    // current section; stale reads must not undo deletions.
                    persistAgentConfig(canonicalizeAgentStorage);
                } catch (err) {
                    process.stderr.write(`[config] persist canonical agent config failed: ${err?.message}\n`);
                }
            }
            return loaded;
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
        webSearchRoute: null,
        modelSettings: {},
        onboarding: {},
        agents: {},
        workflow: { active: 'default' },
        profile: normalizeProfileConfig(null),
        skills: normalizeSkillsConfig(null),
        extensionScopes: normalizeExtensionScopes(null),
        autoClear: { enabled: true },
        compaction: {},
        shell: {},
        update: {},
        recap: { enabled: true },
        modules: {},
    };
}
/** In-lock patch of `skills.disabled` only (avoids whole-config lost-update). */
function buildSkillsDisabledPatch(disabledNames) {
    const names = disabledNames instanceof Set
        ? [...disabledNames]
        : (Array.isArray(disabledNames) ? disabledNames : []);
    const nextSkills = normalizeSkillsConfig({ disabled: names });
    const build = (current) => {
        const cur = { ...current };
        cur.skills = nextSkills;
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

function buildAgentSaveBuilder(config) {
    const canonicalRoutes = canonicalizeAgentStorage(config);
    // Strip ephemeral defaults from providers but preserve any unknown
    // per-provider subkey so future schema additions round-trip through the
    // setup UI without changes here. apiKey is intentionally omitted —
    // provider keys are keychain-only (loadConfig overlays them into memory;
    // persisting would leak plaintext back into mixdog-config.json). It stays
    // in KNOWN_PROVIDER_KEYS so the generic passthrough loop also skips it.
    // `credentialProbeUnavailable` is a per-load probe observation, not user
    // state: persisting it would turn one unreadable-file moment into a marker
    // that outlives the condition on every later load. Listed here so the
    // generic passthrough loop below skips it.
    const KNOWN_PROVIDER_KEYS = new Set(['apiKey', 'enabled', 'baseURL', 'credentialProbeUnavailable']);
    const persistedProviders = {};
    if (canonicalRoutes.providers) {
        for (const [name, val] of Object.entries(canonicalRoutes.providers)) {
            if (!val || typeof val !== 'object') continue;
            const slim = {};
            // NEVER persist an `enabled:false` that came from a credential probe
            // which could not READ the credential this load. Writing it would
            // convert a momentary FS failure into a stored user decision: the
            // marker is stripped on save, so the next load would read that false
            // as a deliberate disable and the provider would stay off for good.
            // Omitting the key leaves `enabled` derived from the probe again on
            // the next load. This can never erase a real user disable: loadConfig
            // drops the marker whenever the stored config states `enabled`
            // itself, so a marker in memory means nothing was stored for it.
            const probeUnavailable = val.credentialProbeUnavailable === true;
            const skipEnabled = probeUnavailable && val.enabled === false;
            if (typeof val.enabled === 'boolean' && !skipEnabled) slim.enabled = val.enabled;
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
    const presets = Array.isArray(canonicalRoutes.presets)
        ? canonicalRoutes.presets.filter(p => p?.id !== 'workflow-search')
        : [];
    const profile = canonicalRoutes.profile ?? normalizeProfileConfig(null);
    const { skills, extensionScopes, autoClear, compaction, shell, modules } = canonicalRoutes;
    const builtins = canonicalizeBuiltinsStorage(config.builtins);
    // Build the replacement from `existingRaw` — the section read INSIDE the
    // file lock — not a snapshot taken before it, so unmanaged keys written by
    // a concurrent instance survive the save (lost-update guard).
    return (existingRaw) => {
        const mcpServers = config.mcpServers || {};
        const next = {
            ...existingRaw,
            providers: persistedProviders,
            mcpServers,
            presets,
            default: canonicalRoutes.default || null,
            maintenance: canonicalRoutes.maintenance,
            webSearchRoute: canonicalRoutes.webSearchRoute,
            modelSettings: canonicalRoutes.modelSettings,
            onboarding: config.onboarding || {},
            agents: canonicalRoutes.agents,
            workflow: config.workflow || { active: 'default' },
            profile,
            skills,
            extensionScopes,
            autoClear,
            compaction,
            shell,
            update: config.update || {},
            recap: config.recap || {},
            modules,
            builtins,
        };
        delete next.workflowRoutes;
        return removeRetiredAgentFields(next);
    };
}
// Managed fields are replaced from the caller's fresh snapshot; unmanaged
// fields rebase on the in-lock current. Provider keys remain keychain-only.
// Use an in-lock field patch rather than a whole-section save for isolated edits.
export function saveConfig(config) {
    persistAgentConfig(buildAgentSaveBuilder(config));
}
// Async twin used by the debounced config-save flush timer.
export async function saveConfigAsync(config) {
    await persistAgentConfigAsync(buildAgentSaveBuilder(config));
}
