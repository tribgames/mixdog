import { configuredAgentRouteCandidates } from '../../../shared/agent-route-config.mjs';
import { loadConfig } from '../config.mjs';
import { getHiddenAgent } from '../internal-agents.mjs';

function normalizeMaintenanceCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate || null;
    const provider = String(candidate.provider || '').trim();
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
            const key = hidden.maintKey || hidden.slot;
            const role = key === 'explore' ? 'explore' : (key === 'memory' ? 'maintainer' : '');
            if (!role) return config?.maintenance?.[key] ?? null;
            const candidates = [
                ...configuredAgentRouteCandidates(config, role),
                role ? config?.default : null,
            ];
            for (const candidate of candidates) {
                const route = normalizeMaintenanceCandidate(candidate);
                if (route) return route;
            }
            return null;
        } catch {
            return null;
        }
    }
    return null;
}
