import { isDeepStrictEqual } from 'node:util';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { hasOwn } from '../../runtime/shared/object.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';
import { normalizeWorkflowRoute } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { ensureProviderEnabled } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { resolveRouteContextState, selectionFastCapable } from '../route-state.mjs';
import {
  canonicalizeAgentRouteStorage,
  isAgentDisabled,
  withAgentDisabled,
} from '../../runtime/shared/agent-route-config.mjs';
import { agentEditorId, resolveDataDir } from './shared.mjs';
import { publishAgentRouteChange } from '../agent-profile-changes.mjs';
import {
  isStoreBot,
  readBotRoute,
  readMixyRoute,
  writeBotRoute,
  writeMixyRoute,
} from '../../runtime/shared/agent-store.mjs';

/** Mixy's runtime id (agent-home.mjs MIXY_AGENT_ID). */
const MIXY_RUNTIME_ID = 'lead';
import {
  canonicalRouteProvider,
  routeChain,
  validateRouteChainProviders,
} from '../../runtime/shared/model-route-chain.mjs';

// Agent route persistence. Route-scope isolation: an agent route owns its
// model AND its effort/fast, stored in config.agents[<id>]. The shared
// config.modelSettings[provider/model] bucket belongs to the MAIN route alone
// (setRoute/setFast/setEffort) — resolveRoute reads it with priority over the
// lead preset, so an agent that reused it silently rewrote Main's effort/fast
// for the next session. The agent's own stored route is the fallback instead,
// and the bucket is never written here.
// Tuning-only edits keep the stored model's effort/fast/modelParameters;
// a model change starts from the resolved defaults. Fast is then clamped
// to what the selected model supports. The ONE normalizer of a chain entry:
// agents, bots, Mixy and the Lead's fallbacks all pass through it.
export async function resolveChainEntry(deps, requested, stored) {
  const { getConfig, resolveRoute, lookupModelMeta, ensureProvidersReady } = deps;
  let selectedRoute = resolveRoute(getConfig(), requested);
  const sameModel =
    clean(selectedRoute.provider) === clean(stored.provider) && clean(selectedRoute.model) === clean(stored.model);
  const inheritedEffort = sameModel ? stored.effort || null : null;
  const inheritedModelParameters = sameModel ? stored.modelParameters || {} : {};
  // A requested percent replaces the stored exact window and requested
  // tokens replace the stored percent.
  const requestsPercent = requested.contextPercent !== undefined;
  const requestsTokens = requested.contextTokens !== undefined;
  const inheritedContextPercent = sameModel && !requestsTokens ? stored.contextPercent : undefined;
  const inheritedContextTokens = sameModel && !requestsPercent ? stored.contextTokens : undefined;
  selectedRoute = {
    ...selectedRoute,
    effort: requested.effort !== undefined ? selectedRoute.effort : inheritedEffort,
    fast: requested.fast !== undefined ? selectedRoute.fast === true : sameModel && stored.fast === true,
    // Main's modelSettings bucket must not decide an agent's Auto effort.
    autoEffort:
      requested.autoEffort !== undefined ? requested.autoEffort !== false : !sameModel || stored.autoEffort !== false,
    modelParameters: requested.modelParameters !== undefined ? selectedRoute.modelParameters : inheritedModelParameters,
    // resolveRoute reads contextPercent from Main's modelSettings bucket;
    // an agent route owns its own.
    contextPercent: requestsPercent ? requested.contextPercent : inheritedContextPercent,
    contextTokens: requestsTokens ? requested.contextTokens : inheritedContextTokens,
  };
  await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
  const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
  // Stored clamped, and not at all at the default window, as for Main.
  const contextState = resolveRouteContextState(selectedRoute, modelMeta);
  if (contextState.contextDefaultPercent !== undefined) selectedRoute.contextTokens = contextState.contextTokens;
  const fastCapable = selectionFastCapable(
    selectedRoute.provider,
    modelMeta,
    selectedRoute.effort,
    selectedRoute.modelParameters
  );
  return { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
}

export function createAgentRouteApi(deps) {
  const { getConfig, resolveRoute, saveConfigAndAdopt, agentRouteFromConfig } = deps;

  function saveDisabled(id, disabled) {
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(withAgentDisabled(getConfig(), id, disabled)));
  }

  // A bot of the store keeps its route in its own folder (agent-store.mjs);
  // Mixy (`lead` here, its runtime id) keeps its own in bots/mixy — never the
  // Lead's route, which the Main route setter owns.
  const dataDir = () => (deps.cfgMod || deps.STANDALONE_DATA_DIR ? resolveDataDir(deps) : '');
  const isMixy = (id) => id === MIXY_RUNTIME_ID && Boolean(dataDir());
  const storeBot = (id) => isStoreBot(dataDir(), id);
  function saveRoute(id, route, keepOff) {
    if (isMixy(id)) {
      writeMixyRoute(dataDir(), route);
      return;
    }
    if (storeBot(id)) {
      writeBotRoute(dataDir(), id, route);
      saveDisabled(id, keepOff);
      return;
    }
    const nextConfig = withAgentDisabled(getConfig(), id, keepOff);
    nextConfig.agents = { ...(nextConfig.agents || {}), [id]: route };
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
  }

  // The route a bot saved of its own ({} when none).
  function ownRoute(id) {
    if (isMixy(id)) return readMixyRoute(dataDir()) || {};
    if (storeBot(id)) return readBotRoute(dataDir(), id) || {};
    return agentRouteFromConfig(getConfig(), id) || {};
  }
  // The route a bot's chats run on: its own, else Main's.
  const chatRoute = (id) => {
    const own = ownRoute(id);
    return normalizeWorkflowRoute(own.provider ? own : resolveRoute(getConfig(), {}));
  };
  // Structural, so equivalent parameter objects in another key order are the same route.
  const plainRoute = (route) => JSON.parse(JSON.stringify(normalizeWorkflowRoute(route) ?? null));
  const sameRoute = (a, b) => isDeepStrictEqual(plainRoute(a), plainRoute(b));

  // Only an explicitly empty provider removes an override: the agent inherits Main.
  async function clearOverride(id) {
    const before = chatRoute(id);
    if (isMixy(id) || storeBot(id)) {
      if (isMixy(id)) writeMixyRoute(dataDir(), null);
      else writeBotRoute(dataDir(), id, null);
    } else {
      const nextConfig = { ...getConfig() };
      const agents = { ...(nextConfig.agents || {}) };
      const hadOverride = Object.hasOwn(agents, id);
      delete agents[id];
      nextConfig.agents = agents;
      if (hadOverride) saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
    }
    const inherited = normalizeWorkflowRoute(resolveRoute(getConfig(), {}));
    // The bot's chats follow Main from their next turn (unless they already do).
    if (inherited && !sameRoute(before, inherited)) await publishAgentRouteChange(id, inherited);
    return { ...(inherited || {}), inherited: true };
  }

  async function setAgentRoute(agentId, next) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and has no configurable route`);
    const requested = { ...(next || {}) };
    // Compare-and-set: fill the route only while the agent has none. A route
    // picked while the model resolved below stays (answered with `skipped`).
    const onlyIfEmpty = requested.onlyIfEmpty === true;
    delete requested.onlyIfEmpty;
    const readStored = () => ownRoute(id);
    const kept = () => ({ ...readStored(), id, skipped: true });
    const stored = readStored();
    if (onlyIfEmpty && clean(stored.provider)) return kept();
    // Mixy is never off: its route request is a model pick alone, and an
    // on/off request alone changes nothing.
    if (isMixy(id) && hasOwn(requested, 'disabled')) {
      delete requested.disabled;
      if (!Object.keys(requested).length) return { ...stored, id };
    }
    // Off is an explicit state, stored apart from the route so the model the
    // user picked survives and comes back when the agent is switched on. An
    // off request that also carries a model saves that model and stays off.
    const keepOff = requested.disabled === true;
    if (keepOff && !(clean(requested.provider) && clean(requested.model))) {
      saveDisabled(id, true);
      // An explicitly empty provider still asks to drop the override, as it
      // does for an agent that stays on: off and inheriting Main.
      if (hasOwn(requested, 'provider') && !clean(requested.provider)) {
        return { ...(await clearOverride(id)), id, disabled: true };
      }
      return { ...stored, id, disabled: true };
    }
    if (requested.disabled === false && Object.keys(requested).length === 1) {
      saveDisabled(id, false);
      return { ...stored, id, disabled: false, inherited: !stored.provider };
    }
    delete requested.disabled;
    // Tuning-only edits must preserve the selected agent model, not silently inherit Main.
    const current = stored.provider ? stored : normalizeWorkflowRoute(resolveRoute(getConfig(), {})) || {};
    if (!hasOwn(requested, 'provider')) requested.provider = current.provider;
    if (!hasOwn(requested, 'model') && clean(requested.provider) === clean(current.provider)) {
      requested.model = current.model;
    }
    if (!clean(requested.provider)) return clearOverride(id);
    if (!clean(requested.model)) throw new Error('agent route requires provider and model');
    // An explicit list is validated; the stored one may hold a fallback on the
    // picked model's provider, which stays saved untouched and inactive.
    const explicitFallbacks = hasOwn(requested, 'fallbacks');
    const chain = routeChain({
      ...requested,
      fallbacks: explicitFallbacks ? requested.fallbacks : stored.fallbacks,
    });
    validateRouteChainProviders(chain, { allowDuplicates: !explicitFallbacks });
    const storedChain = routeChain(stored);
    const resolved = [];
    const usedProviders = new Set();
    for (const entry of chain) {
      const provider = canonicalRouteProvider(entry.provider);
      const inactive = usedProviders.has(provider);
      usedProviders.add(provider);
      const previous = storedChain.find(
        (candidate) => candidate.provider === entry.provider && candidate.model === entry.model
      );
      resolved.push(inactive ? entry : await resolveChainEntry(deps, entry, previous || {}));
    }
    const [primary, ...fallbacks] = resolved;
    const routeToSave = normalizeWorkflowRoute({ ...primary, fallbacks });
    if (!routeToSave) throw new Error('agent route requires provider and model');
    // No await from here to the write: the emptiness checked is the emptiness
    // written over. An off agent stays off when it was only back-filled.
    // A store bot's or Mixy's route is read from its folder on disk right here.
    // An agent routed in the config file may have been written by another
    // process whose change notification is still pending: re-read it first.
    if (onlyIfEmpty && !isMixy(id) && !storeBot(id)) deps.reloadFullConfig?.();
    if (onlyIfEmpty && clean(readStored().provider)) return kept();
    const stayOff = onlyIfEmpty ? isAgentDisabled(getConfig(), id) : keepOff;
    // Picking a model is also the "on" switch unless the request keeps it off.
    const before = chatRoute(id);
    saveRoute(id, routeToSave, stayOff);
    // The bot's existing chats move onto it from their next turn (unless they already run it).
    if (!sameRoute(before, routeToSave)) await publishAgentRouteChange(id, routeToSave);
    return stayOff ? { ...routeToSave, id, disabled: true } : routeToSave;
  }

  return { setAgentRoute };
}
