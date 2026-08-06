import { configuredAgentRouteCandidates } from '../../runtime/shared/agent-route-config.mjs';
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
  const agentRoute = !clean(args.preset)
    ? configuredAgentRouteCandidates(config, agentName)
      .map((candidate) => normalizeAgentRoute(candidate))
      .find(Boolean) || null
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

  const mainPreset = !clean(args.preset)
    ? findPreset(config, config?.default)
    : null;
  if (normalizeAgentRoute(mainPreset)) {
    return { presetName: mainPreset.id || mainPreset.name, preset: mainPreset };
  }

  const presetName = clean(args.preset);
  if (!presetName) throw new Error(`agent: agent "${agentName}" has no Main model assignment`);
  const preset = findPreset(config, presetName) || synthesizePreset(config, presetName);
  if (!preset) throw new Error(`agent: preset "${presetName}" not found`);
  if (!normalizeAgentRoute(preset)) throw new Error(`agent: preset "${presetName}" has no complete route`);
  return { presetName, preset };
}
