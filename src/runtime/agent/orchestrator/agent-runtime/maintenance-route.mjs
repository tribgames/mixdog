import { isKnownProvider } from '../../../../standalone/provider-admin.mjs';
import { loadConfig } from '../config.mjs';
import { getHiddenAgent } from '../internal-agents.mjs';

const DEFAULT_AGENT_ROUTE_PROVIDER = 'anthropic-oauth';

function normalizeMaintenanceCandidate(candidate, config) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate || null;
    const configuredProvider = String(config?.defaultProvider || '').trim();
    const fallbackProvider = isKnownProvider(configuredProvider)
        ? configuredProvider
        : DEFAULT_AGENT_ROUTE_PROVIDER;
    const provider = String(candidate.provider || fallbackProvider).trim();
    const model = String(candidate.model || '').trim();
    if (!provider || !model) return null;
    return {
        provider,
        model,
        effort: String(candidate.effort || '').trim() || undefined,
        fast: candidate.fast === true,
    };
}

/**
 * Resolve the maintenance route for a hidden role without creating an agent
 * session. Session-backed dispatch and tiny one-shot completions share this
 * model-selection boundary.
 */
export function resolveMaintenanceRoute({ preset, optsPreset, agent, config: cfgIn = null }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!agent) return null;
    const hidden = getHiddenAgent(agent);
    if (hidden) {
        try {
            const config = cfgIn || loadConfig({ secrets: false });
            const maint = config?.maintenance || {};
            const key = hidden.maintKey || hidden.slot;
            const role = key === 'explore' ? 'explore' : (key === 'memory' ? 'maintainer' : '');
            const workflowSlot = key === 'explore' ? 'explorer' : (key === 'memory' ? 'memory' : '');
            if (!role) return maint[key] ?? null;
            const candidates = [
                role ? config?.agents?.[role] : null,
                key === 'memory' ? config?.agents?.maintenance : null,
                workflowSlot ? config?.workflowRoutes?.[workflowSlot] : null,
                maint[key],
                role ? config?.default : null,
            ];
            for (const candidate of candidates) {
                const route = normalizeMaintenanceCandidate(candidate, config);
                if (route) return route;
            }
            return null;
        } catch {
            return null;
        }
    }
    return null;
}
