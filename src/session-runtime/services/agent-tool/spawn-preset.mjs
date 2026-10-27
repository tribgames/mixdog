import { configuredAgentRouteCandidates } from '../../../runtime/shared/agent-route-config.mjs';
import { executionFallbacks } from '../../../runtime/shared/model-route-chain.mjs';
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
        ...(args.autoEffort === false ? { autoEffort: false } : {}),
        tools: 'full',
      },
    };
  }

  const agentName = normalizeAgentName(args.agent);
  // The agent's stored route: config.agents, or a store bot's own folder.
  const candidates = !clean(args.preset) ? configuredAgentRouteCandidates(config, agentName) : [];
  const storedCandidate = candidates.find((candidate) => normalizeAgentRoute(candidate));
  const agentRoute = storedCandidate ? normalizeAgentRoute(storedCandidate) : null;
  const storedFallbacks = agentRoute
    ? executionFallbacks({ ...agentRoute, fallbacks: storedCandidate.fallbacks })
    : undefined;
  // Where the spawned session reads its fallback chain at each hop
  // (route-fallback-chain.mjs): this agent's route, else Main's.
  const fallbackSource = { agent: agentName };
  if (agentRoute) {
    return {
      presetName: agentPresetName(agentName),
      preset: {
        id: `agent-${agentName}`,
        name: agentPresetName(agentName),
        type: 'agent',
        provider: agentRoute.provider,
        model: agentRoute.model,
        ...(storedFallbacks?.length ? { fallbacks: storedFallbacks.map(normalizeAgentRoute) } : {}),
        fallbackSource,
        effort: agentRoute.effort,
        fast: agentRoute.fast === true,
        ...(agentRoute.autoEffort === false ? { autoEffort: false } : {}),
        ...(agentRoute.modelParameters ? { modelParameters: agentRoute.modelParameters } : {}),
        ...(agentRoute.contextPercent ? { contextPercent: agentRoute.contextPercent } : {}),
        ...(agentRoute.contextTokens ? { contextTokens: agentRoute.contextTokens } : {}),
        tools: 'full',
      },
    };
  }

  const mainPreset = !clean(args.preset) ? findPreset(config, config?.default) : null;
  if (normalizeAgentRoute(mainPreset)) {
    return { presetName: mainPreset.id || mainPreset.name, preset: { ...mainPreset, fallbackSource } };
  }

  const presetName = clean(args.preset);
  if (!presetName) throw new Error(`agent: agent "${agentName}" has no Main model assignment`);
  const stored = findPreset(config, presetName);
  const preset = stored ? { ...stored, fallbackSource: { preset: presetName } } : synthesizePreset(config, presetName);
  if (!preset) throw new Error(`agent: preset "${presetName}" not found`);
  if (!normalizeAgentRoute(preset)) throw new Error(`agent: preset "${presetName}" has no complete route`);
  return { presetName, preset };
}
