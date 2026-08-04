import { isKnownProvider } from '../provider-admin.mjs';
import {
  DEFAULT_AGENT_PRESETS,
  DEFAULT_PROVIDER,
} from './tool-def.mjs';
import {
  agentPresetName,
  clean,
  findPreset,
  normalizeAgentName,
  normalizeAgentRoute,
  synthesizePreset,
} from './helpers.mjs';

export function resolveAgentSpawnPreset(config, args = {}) {
  if (args.provider && args.model) {
    return {
      presetName: args.preset || '__direct__',
      preset: {
        id: '__direct__',
        name: '__DIRECT__',
        type: 'agent',
        provider: clean(args.provider),
        model: clean(args.model),
        effort: clean(args.effort) || undefined,
        fast: args.fast === true,
        tools: 'full',
      },
    };
  }

  const agentName = normalizeAgentName(args.agent);
  const configuredDefault = clean(config?.defaultProvider);
  const fallbackProvider = configuredDefault && isKnownProvider(configuredDefault)
    ? configuredDefault
    : DEFAULT_PROVIDER;
  const workflowSlot = agentName === 'explore' ? 'explorer'
    : (agentName === 'maintainer' ? 'memory' : '');
  const maintenanceSlot = agentName === 'explore' ? 'explore'
    : (agentName === 'maintainer' ? 'memory' : '');
  const agentRoute = !clean(args.preset)
    ? (normalizeAgentRoute(config?.agents?.[agentName], fallbackProvider)
      || (agentName === 'maintainer' ? normalizeAgentRoute(config?.agents?.maintenance, fallbackProvider) : null)
      || normalizeAgentRoute(config?.workflowRoutes?.[workflowSlot], fallbackProvider)
      || normalizeAgentRoute(config?.maintenance?.[maintenanceSlot], fallbackProvider))
    : null;
  if (agentRoute) {
    return {
      presetName: agentPresetName(agentName),
      preset: {
        id: `agent-${agentName}`,
        name: agentPresetName(agentName),
        type: 'agent',
        provider: agentRoute.provider,
        model: agentRoute.model,
        effort: agentRoute.effort,
        fast: agentRoute.fast === true,
        tools: 'full',
      },
    };
  }

  const mainPreset = !clean(args.preset) && (agentName === 'explore' || agentName === 'maintainer')
    ? findPreset(config, config?.default)
    : null;
  if (mainPreset) return { presetName: mainPreset.id || mainPreset.name, preset: mainPreset };

  const presetName = clean(args.preset) || DEFAULT_AGENT_PRESETS[agentName];
  if (!presetName) throw new Error(`agent: agent "${agentName}" has no model assignment`);
  const preset = findPreset(config, presetName) || synthesizePreset(config, presetName);
  if (!preset) throw new Error(`agent: preset "${presetName}" not found`);
  return { presetName, preset };
}
