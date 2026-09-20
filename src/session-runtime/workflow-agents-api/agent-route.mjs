import { clean } from '../session-text.mjs';
import { hasOwn } from '../../runtime/shared/object.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';
import { normalizeWorkflowRoute } from '../workflow.mjs';
import { ensureProviderEnabled } from '../config-helpers.mjs';
import { fastCapableFor } from '../model-capabilities.mjs';
import { canonicalizeAgentRouteStorage, withAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { agentEditorId } from './shared.mjs';

// Agent route persistence. Route-scope isolation: an agent route owns its
// model AND its effort/fast, stored in config.agents[<id>]. The shared
// config.modelSettings[provider/model] bucket belongs to the MAIN route alone
// (setRoute/setFast/setEffort) — resolveRoute reads it with priority over the
// lead preset, so an agent that reused it silently rewrote Main's effort/fast
// for the next session. The agent's own stored route is the fallback instead,
// and the bucket is never written here.
export function createAgentRouteApi(deps) {
  const { getConfig, resolveRoute, lookupModelMeta, saveConfigAndAdopt, ensureProvidersReady, agentRouteFromConfig } =
    deps;

  function saveDisabled(id, disabled) {
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(withAgentDisabled(getConfig(), id, disabled)));
  }

  // Only an explicitly empty provider removes an override: the agent inherits Main.
  function clearOverride(id) {
    const nextConfig = { ...getConfig() };
    const agents = { ...(nextConfig.agents || {}) };
    const hadOverride = Object.hasOwn(agents, id);
    delete agents[id];
    nextConfig.agents = agents;
    if (hadOverride) saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
    const inherited = normalizeWorkflowRoute(resolveRoute(getConfig(), {}));
    return { ...(inherited || {}), inherited: true };
  }

  // Tuning-only edits keep the stored model's effort/fast/modelParameters;
  // a model change starts from the resolved defaults. Fast is then clamped
  // to what the selected model supports.
  async function resolveSelectedRoute(requested, stored) {
    let selectedRoute = resolveRoute(getConfig(), requested);
    const sameModel =
      clean(selectedRoute.provider) === clean(stored.provider) && clean(selectedRoute.model) === clean(stored.model);
    const inheritedEffort = sameModel ? stored.effort || null : null;
    const inheritedModelParameters = sameModel ? stored.modelParameters || {} : {};
    selectedRoute = {
      ...selectedRoute,
      effort: requested.effort !== undefined ? selectedRoute.effort : inheritedEffort,
      fast: requested.fast !== undefined ? selectedRoute.fast === true : sameModel && stored.fast === true,
      modelParameters:
        requested.modelParameters !== undefined ? selectedRoute.modelParameters : inheritedModelParameters,
    };
    await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
    const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
    const fastCapable = fastCapableFor(
      selectedRoute.provider,
      modelMeta,
      selectedRoute.effort,
      selectedRoute.modelParameters
    );
    return { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
  }

  async function setAgentRoute(agentId, next) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and has no configurable route`);
    const requested = { ...(next || {}) };
    const stored = agentRouteFromConfig(getConfig(), id) || {};
    // Off is an explicit state, stored apart from the route so the model the
    // user picked survives and comes back when the agent is switched on.
    if (requested.disabled === true) {
      saveDisabled(id, true);
      return { ...stored, id, disabled: true };
    }
    if (requested.disabled === false && Object.keys(requested).length === 1) {
      saveDisabled(id, false);
      return { ...stored, id, disabled: false, inherited: !stored.provider };
    }
    // Tuning-only edits must preserve the selected agent model, not silently inherit Main.
    const current = stored.provider ? stored : normalizeWorkflowRoute(resolveRoute(getConfig(), {})) || {};
    if (!hasOwn(requested, 'provider')) requested.provider = current.provider;
    if (!hasOwn(requested, 'model') && clean(requested.provider) === clean(current.provider)) {
      requested.model = current.model;
    }
    if (!clean(requested.provider)) return clearOverride(id);
    if (!clean(requested.model)) throw new Error('agent route requires provider and model');
    const routeToSave = normalizeWorkflowRoute(await resolveSelectedRoute(requested, stored));
    if (!routeToSave) throw new Error('agent route requires provider and model');
    // Picking a model is also the "on" switch — the two states are exclusive.
    const nextConfig = withAgentDisabled(getConfig(), id, false);
    nextConfig.agents = { ...(nextConfig.agents || {}), [id]: routeToSave };
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
    return routeToSave;
  }

  return { setAgentRoute };
}
