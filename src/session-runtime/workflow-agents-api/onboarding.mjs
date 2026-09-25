import { clean } from '../session-text.mjs';
import { hasOwn } from '../../runtime/shared/object.mjs';
import {
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  workflowPresetId,
  WORKFLOW_ROUTE_SLOTS,
  FIXED_AGENT_SLOTS,
  normalizeWebSearchRouteConfig,
  WEB_SEARCH_DEFAULT_MODEL,
  WEB_SEARCH_DEFAULT_PROVIDER,
} from '../workflow.mjs';
import { ONBOARDING_VERSION } from '../quick-web-search-models.mjs';
import { canonicalizeAgentRouteStorage } from '../../runtime/shared/agent-route-config.mjs';
import { resolveDataDir } from './shared.mjs';

// Onboarding slot picks: lead → default preset, agent → worker route,
// memory → maintainer route. Only slots the caller sent are touched.
function applyWorkflowSlots(workflowInput, draft) {
  for (const slot of WORKFLOW_ROUTE_SLOTS) {
    if (!hasOwn(workflowInput, slot)) continue;
    const normalized = normalizeWorkflowRoute(workflowInput[slot]);
    if (slot === 'lead') {
      if (!normalized) continue;
      draft.presets = upsertWorkflowPreset(draft.presets, 'lead', normalized);
      draft.defaultPreset = workflowPresetId('lead');
    } else if (slot === 'agent') {
      if (normalized) draft.agentRoutes.worker = normalized;
      else delete draft.agentRoutes.worker;
    } else if (slot === 'memory') {
      if (normalized) draft.agentRoutes.maintainer = normalized;
      else delete draft.agentRoutes.maintainer;
    }
  }
}

function applyAgentRouteInput(agentInput, agentRoutes, configurableIds) {
  const nextAgents = { ...agentRoutes };
  for (const id of configurableIds) {
    if (!hasOwn(agentInput, id)) continue;
    const routeToSave = normalizeWorkflowRoute(agentInput[id]);
    if (routeToSave) nextAgents[id] = routeToSave;
    else delete nextAgents[id];
  }
  return nextAgents;
}

function webSearchRouteToSave(webSearchRoute) {
  if (clean(webSearchRoute.provider)) return normalizeWebSearchRouteConfig(webSearchRoute);
  return normalizeWebSearchRouteConfig({
    provider: WEB_SEARCH_DEFAULT_PROVIDER,
    model: WEB_SEARCH_DEFAULT_MODEL,
    toolType: webSearchRoute.toolType,
  });
}

export function createOnboardingApi(deps) {
  const { getConfig, getRoute, setRouteState, resolveRoute, saveConfigAndAdopt, listCustomAgentIds } = deps;
  return {
    async completeOnboarding(payload = {}) {
      // Only fall back to the live runtime route when the caller actually sent a
      // defaultRoute. The onboarding "partial save" path (Main left unset, only
      // Web Search/agent picks) omits defaultRoute entirely and must NOT persist the
      // current route as Main or recreate the session.
      const config = getConfig();
      const nextConfig = { ...config };
      const defaultRoute = hasOwn(payload, 'defaultRoute')
        ? normalizeWorkflowRoute(payload.defaultRoute, getRoute())
        : null;
      const draft = {
        presets: Array.isArray(nextConfig.presets) ? nextConfig.presets.slice() : [],
        defaultPreset: nextConfig.default,
        agentRoutes: { ...(nextConfig.agents || {}) },
      };
      if (defaultRoute) {
        draft.presets = upsertWorkflowPreset(draft.presets, 'lead', defaultRoute);
        draft.defaultPreset = workflowPresetId('lead');
      }
      const workflowInput =
        payload.workflowRoutes && typeof payload.workflowRoutes === 'object' ? payload.workflowRoutes : {};
      applyWorkflowSlots(workflowInput, draft);
      if (draft.defaultPreset !== undefined) nextConfig.default = draft.defaultPreset;
      nextConfig.presets = draft.presets;
      nextConfig.agents = draft.agentRoutes;

      const agentInput = payload.agentRoutes && typeof payload.agentRoutes === 'object' ? payload.agentRoutes : null;
      if (agentInput) {
        const configurableIds = new Set([
          ...FIXED_AGENT_SLOTS.map((agent) => agent.id),
          ...(listCustomAgentIds?.(resolveDataDir(deps)) || []),
        ]);
        nextConfig.agents = applyAgentRouteInput(agentInput, draft.agentRoutes, configurableIds);
      }
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
      };
      if (payload.webSearchRoute) {
        const webSearchToSave = webSearchRouteToSave(payload.webSearchRoute);
        if (webSearchToSave) nextConfig.webSearchRoute = webSearchToSave;
      }

      saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
      if (defaultRoute) {
        setRouteState(
          resolveRoute(getConfig(), {
            provider: defaultRoute.provider,
            model: defaultRoute.model,
            effort: defaultRoute.effort,
          })
        );
        deps.invalidatePreSessionToolSurface?.();
      }
      return this.getOnboardingStatus();
    },
  };
}
