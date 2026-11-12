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

// A spawn that pins a model (`provider` + `model`) runs on that model with what
// the model picker selects for it (`args.modelDefaults`: its effort and fast),
// the effort and fast the caller asked for over that. It has no fallback chain:
// the named model answers or the failure is the answer. When the agent's route
// is already on that model, the agent's own settings are the ones that apply,
// an effort the model does not offer replaced by the model's default.
export function resolveAgentSpawnPreset(config, args = {}) {
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
  // `strict`: the spawn named its model, so no other model may answer it (no chain, no source).
  // A strict preset is a direct one by identity: the send flow follows the agent's configured route
  // only for a worker on the agent's own preset identity, and a named model is kept for the worker's life.
  const agentPreset = (effort, fast, strict) => ({
    presetName: strict ? args.preset || '__direct__' : agentPresetName(agentName),
    preset: {
      id: strict ? '__direct__' : `agent-${agentName}`,
      name: strict ? '__DIRECT__' : agentPresetName(agentName),
      type: 'agent',
      provider: agentRoute.provider,
      model: agentRoute.model,
      ...(!strict && storedFallbacks?.length ? { fallbacks: storedFallbacks.map(normalizeAgentRoute) } : {}),
      ...(strict ? {} : { fallbackSource }),
      effort,
      fast: fast ?? agentRoute.fast === true,
      ...(agentRoute.autoEffort === false ? { autoEffort: false } : {}),
      ...(agentRoute.modelParameters ? { modelParameters: agentRoute.modelParameters } : {}),
      ...(agentRoute.contextPercent ? { contextPercent: agentRoute.contextPercent } : {}),
      ...(agentRoute.contextTokens ? { contextTokens: agentRoute.contextTokens } : {}),
      tools: 'full',
    },
  });

  if (args.provider && args.model) {
    const provider = clean(args.provider);
    const model = clean(args.model);
    const askedEffort = clean(args.effort) || undefined;
    const askedFast = args.fast === undefined ? undefined : args.fast === true;
    const defaults = args.modelDefaults || {};
    if (agentRoute?.provider === provider && agentRoute.model === model) {
      // The asked effort, else the agent's own, held to what the model offers (when the catalog said).
      const own = askedEffort || agentRoute.effort;
      const unoffered = own && Array.isArray(defaults.efforts) && !defaults.efforts.includes(own);
      return agentPreset(unoffered ? clean(defaults.effort) || undefined : own, askedFast, true);
    }
    return {
      presetName: args.preset || '__direct__',
      preset: {
        id: '__direct__',
        name: '__DIRECT__',
        type: 'agent',
        provider,
        model,
        effort: askedEffort || clean(defaults.effort) || undefined,
        fast: askedFast ?? defaults.fast === true,
        ...(args.autoEffort === false ? { autoEffort: false } : {}),
        tools: 'full',
      },
    };
  }

  if (agentRoute) return agentPreset(agentRoute.effort, undefined, false);

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
