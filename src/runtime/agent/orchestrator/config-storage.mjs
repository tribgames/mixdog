import { hasExtensionScopes, normalizeExtensionScopes } from '../../shared/extension-scopes.mjs';
import { agentRouteStorageNeedsMigration, canonicalizeAgentRouteStorage } from '../../shared/agent-route-config.mjs';
import profileConfig from '../../shared/profile-config.cjs';
import { normalizeAgentProviderId, normalizePreset } from './config-presets.mjs';

const { normalizeProfileConfig } = profileConfig;
const RETIRED_LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio']);
const RETIRED_AGENT_FIELDS = Object.freeze([
    'fastModels', 'agentMaintenance', 'runtime', 'search', 'searchRoute',
    'capabilities', 'defaultProvider', 'guide', 'mcpProjectOverrides',
]);

export function removeRetiredAgentFields(value) {
    for (const key of RETIRED_AGENT_FIELDS) delete value[key];
    return value;
}

export function normalizeSkillsConfig(value = {}) {
    const raw = value && typeof value === 'object' ? value : {};
    const disabled = Array.isArray(raw.disabled)
        ? [...new Set(raw.disabled.map((n) => String(n).trim()).filter(Boolean))]
        : [];
    disabled.sort((a, b) => a.localeCompare(b));
    return { disabled };
}

export function normalizeWebSearchRoute(route) {
    if (!route || typeof route !== 'object' || Array.isArray(route))
        return null;
    const provider = normalizeAgentProviderId(route.provider);
    const model = String(route.model || '').trim();
    if (!provider && model) {
        return {
            provider: 'default',
            model: 'default',
            ...(String(route.toolType || '').trim() ? { toolType: String(route.toolType).trim() } : {}),
        };
    }
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

export function normalizeMaintenanceRoutes(rawMaint) {
    const out = {};
    for (const [slot, value] of Object.entries(rawMaint || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const provider = normalizeAgentProviderId(value.provider);
            const model = String(value.model || '').trim();
            if (provider && model) {
                const route = { provider, model };
                const effort = String(value.effort || '').trim();
                if (effort) route.effort = effort;
                if (value.fast === true) route.fast = true;
                out[slot] = route;
            }
        }
    }
    return out;
}

function configObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function nonEmptyConfigObject(value) {
    return Object.keys(value).length > 0 ? value : undefined;
}

export function canonicalizeAutoClearStorage(value) {
    const raw = configObject(value);
    const next = { ...raw };
    const idleMs = Number(raw.idleMs ?? raw.thresholdMs ?? raw.idleMillis);
    const providerSource = configObject(raw.providerIdleMs ?? raw.providerDefaults ?? raw.providers);
    const providerIdleMs = {};
    for (const [key, candidate] of Object.entries(providerSource)) {
        const provider = String(key || '').trim().toLowerCase();
        const duration = Number(candidate);
        if (!provider || !Number.isFinite(duration) || duration <= 0) continue;
        providerIdleMs[provider] = Math.max(60_000, Math.round(duration));
    }
    delete next.thresholdMs;
    delete next.idleMillis;
    delete next.providerDefaults;
    delete next.providers;
    delete next.custom;
    if (Number.isFinite(idleMs) && idleMs > 0) next.idleMs = Math.max(60_000, Math.round(idleMs));
    else delete next.idleMs;
    if (Object.keys(providerIdleMs).length) next.providerIdleMs = providerIdleMs;
    else delete next.providerIdleMs;
    if (Object.hasOwn(raw, 'enabled')) next.enabled = raw.enabled !== false;
    if (Object.hasOwn(raw, 'minContextPercent')) {
        const percent = Number(raw.minContextPercent);
        if (Number.isFinite(percent)) next.minContextPercent = Math.min(100, Math.max(0, Math.round(percent)));
        else delete next.minContextPercent;
    }
    return nonEmptyConfigObject(next);
}

export function canonicalizeCompactionStorage(value) {
    const raw = configObject(value);
    const next = { ...raw };
    if (!next.summaryModel && raw.semanticModel) next.summaryModel = raw.semanticModel;
    if (!next.memoryTimeoutMs && raw.recallMemoryTimeoutMs) next.memoryTimeoutMs = raw.recallMemoryTimeoutMs;
    if (Object.hasOwn(raw, 'auto') || Object.hasOwn(raw, 'enabled')) {
        next.auto = raw.auto !== false && raw.enabled !== false;
    }
    for (const key of [
        'type', 'compactType', 'compact_type', 'semantic', 'semanticModel', 'prune', 'tailTurns',
        'recallMemoryTimeoutMs', 'recallIngestLimit', 'recallChunkLimit', 'recallLimit',
        'recallCycle1BatchSize', 'recallRowsPerSession', 'recallWindowSize',
        'recallConcurrency', 'recallCycle1DeadlineMs',
    ]) delete next[key];
    delete next.enabled;
    return nonEmptyConfigObject(next);
}

export function canonicalizeShellStorage(value) {
    const raw = configObject(value);
    const next = { ...raw };
    const command = String(raw.command ?? raw.path ?? raw.executable ?? raw.shell ?? '').trim();
    delete next.path;
    delete next.executable;
    delete next.shell;
    if (command) next.command = command;
    else delete next.command;
    return nonEmptyConfigObject(next);
}

export function canonicalizeModulesStorage(value) {
    const modules = configObject(value);
    delete modules.memory;
    if (Object.hasOwn(modules, 'webSearch')) {
        const raw = modules.webSearch;
        const isObject = raw && typeof raw === 'object' && !Array.isArray(raw);
        modules.webSearch = {
            ...(isObject ? raw : {}),
            enabled: isObject ? raw.enabled !== false : raw !== false,
        };
    }
    return nonEmptyConfigObject(modules);
}

export function normalizedModelSettings(raw = {}) {
    return raw.modelSettings && typeof raw.modelSettings === 'object'
        ? { ...raw.modelSettings }
        : {};
}

export function canonicalizeBuiltinsStorage(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
        Object.entries(raw)
            .filter(([id, entry]) => String(id || '').trim() && entry && typeof entry === 'object' && !Array.isArray(entry))
            .map(([id, entry]) => [id, { ...entry, installed: entry.installed === true }]),
    );
}

function retiredLocalProviderStoragePresent(value = {}) {
    const retiredRoute = (route) => RETIRED_LOCAL_PROVIDER_IDS.has(String(route?.provider || '').trim());
    return [...RETIRED_LOCAL_PROVIDER_IDS].some((id) => Object.hasOwn(value?.providers || {}, id))
        || (Array.isArray(value?.presets) && value.presets.some(retiredRoute))
        || Object.values(configObject(value?.agents)).some(retiredRoute)
        || Object.values(configObject(value?.maintenance)).some(retiredRoute)
        || Object.keys(configObject(value?.modelSettings)).some((key) =>
            [...RETIRED_LOCAL_PROVIDER_IDS].some((id) => key.startsWith(`${id}/`)));
}

export function canonicalizeAgentStorage(value = {}) {
    const next = canonicalizeAgentRouteStorage(value);
    const removedPresetIds = new Set(
        (Array.isArray(next.presets) ? next.presets : [])
            .filter((preset) => RETIRED_LOCAL_PROVIDER_IDS.has(String(preset?.provider || '').trim()))
            .map((preset) => String(preset?.id || preset?.name || '').trim())
            .filter(Boolean),
    );
    next.providers = configObject(next.providers);
    for (const id of RETIRED_LOCAL_PROVIDER_IDS) delete next.providers[id];
    next.presets = Array.isArray(next.presets)
        ? next.presets
            .map((preset) => normalizePreset(preset))
            .filter((preset) => preset && !RETIRED_LOCAL_PROVIDER_IDS.has(preset.provider))
        : [];
    if (removedPresetIds.has(String(next.default || '').trim())) next.default = null;
    next.agents = Object.fromEntries(
        Object.entries(configObject(next.agents))
            .filter(([, route]) => !RETIRED_LOCAL_PROVIDER_IDS.has(String(route?.provider || '').trim())),
    );
    next.maintenance = Object.fromEntries(
        Object.entries(configObject(next.maintenance))
            .filter(([, route]) => !RETIRED_LOCAL_PROVIDER_IDS.has(String(route?.provider || '').trim())),
    );
    next.modelSettings = Object.fromEntries(
        Object.entries(normalizedModelSettings(value))
            .filter(([key]) => ![...RETIRED_LOCAL_PROVIDER_IDS].some((id) => key.startsWith(`${id}/`))),
    );
    const autoClear = canonicalizeAutoClearStorage(next.autoClear);
    if (autoClear) next.autoClear = autoClear;
    else delete next.autoClear;
    const compaction = canonicalizeCompactionStorage(next.compaction);
    if (compaction) next.compaction = compaction;
    else delete next.compaction;
    const shell = canonicalizeShellStorage(next.shell);
    if (shell) next.shell = shell;
    else delete next.shell;
    if (Object.hasOwn(next, 'profile')) {
        next.profile = normalizeProfileConfig(next.profile);
    }
    if (Object.hasOwn(next, 'skills')) {
        const skills = normalizeSkillsConfig(next.skills);
        if (skills.disabled.length) next.skills = skills;
        else delete next.skills;
    }
    if (Object.hasOwn(next, 'extensionScopes')) {
        const scopes = normalizeExtensionScopes(next.extensionScopes);
        if (hasExtensionScopes(scopes)) next.extensionScopes = scopes;
        else delete next.extensionScopes;
    }
    next.webSearchRoute = normalizeWebSearchRoute(next.webSearchRoute);
    const modules = canonicalizeModulesStorage(next.modules);
    if (modules) next.modules = modules;
    else delete next.modules;
    return removeRetiredAgentFields(next);
}

export function agentConfigStorageNeedsMigration(value = {}) {
    const modules = value?.modules;
    const presets = Array.isArray(value?.presets) ? value.presets : [];
    const canonical = canonicalizeAgentStorage(value);
    const normalizedFields = ['autoClear', 'compaction', 'shell', 'profile', 'skills', 'extensionScopes', 'modules', 'guide'];
    return agentRouteStorageNeedsMigration(value)
        || retiredLocalProviderStoragePresent(value)
        || RETIRED_AGENT_FIELDS.some((key) => key !== 'guide' && Object.hasOwn(value || {}, key))
        || presets.some((preset) => !normalizePreset(preset))
        || (modules && typeof modules === 'object' && Object.hasOwn(modules, 'memory'))
        || normalizedFields.some((key) => JSON.stringify(value?.[key]) !== JSON.stringify(canonical?.[key]));
}
