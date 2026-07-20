import { clean, hasOwn, sessionHasConversationMessages, tombstoneOnClose } from './session-text.mjs';
import { isKnownProvider } from '../standalone/provider-admin.mjs';
import {
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  workflowPresetId,
  WORKFLOW_ROUTE_SLOTS,
  FIXED_AGENT_SLOTS,
  agentPresetSlot,
  normalizeAgentId,
  normalizeWorkflowId,
  DEFAULT_WORKFLOW_ID,
  normalizeSearchRouteConfig,
} from './workflow.mjs';
import { ONBOARDING_VERSION } from './quick-search-models.mjs';
import { findOutputStyle } from './output-styles.mjs';
import { ensureProviderEnabled } from './config-helpers.mjs';
import { fastCapableFor, saveModelSettings } from './model-capabilities.mjs';

// Onboarding + agents/workflows/output-style selection surface. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live getters/setters for the mutable config/route/
// session locals plus the closure callbacks.
export function createWorkflowAgentsApi(deps) {
  const {
    getConfig, getRoute, setRouteState, getSession, setSession, getConfigHasSecrets,
    cfgMod, reg, mgr, STANDALONE_DATA_DIR,
    resolveRoute, lookupModelMeta, adoptConfig, saveConfigAndAdopt, displayConfig, ensureProvidersReady,
    agentRouteFromConfig, loadAgentDefinition, activeWorkflowId, listWorkflowPacks,
    loadWorkflowPack, workflowSummary,
    getOutputStyleStatusCached, seedOutputStyleStatusCache, scheduleOutputStyleSave,
    recreateCurrentSessionIfReady, notifyFnForSession, invalidateContextStatusCache,
  } = deps;
  return {
    async completeOnboarding(payload = {}) {
      // Only fall back to the live runtime route when the caller actually sent a
      // defaultRoute. The onboarding "partial save" path (Main left unset, only
      // Search/agent picks) omits defaultRoute entirely and must NOT persist the
      // current route as Main or recreate the session.
      const config = getConfig();
      const defaultRoute = hasOwn(payload, 'defaultRoute')
        ? normalizeWorkflowRoute(payload.defaultRoute, getRoute())
        : null;
      const workflowInput = payload.workflowRoutes && typeof payload.workflowRoutes === 'object'
        ? payload.workflowRoutes
        : {};
      const nextConfig = { ...config };
      if (hasOwn(payload, 'defaultProvider')) {
        const requested = clean(payload.defaultProvider);
        if (requested) {
          if (!isKnownProvider(requested)) throw new Error(`unknown provider "${payload.defaultProvider}"`);
          nextConfig.defaultProvider = requested;
        }
      }
      let presets = Array.isArray(nextConfig.presets) ? nextConfig.presets.slice() : [];
      const workflowRoutes = { ...(nextConfig.workflowRoutes || {}) };
      const touchedWorkflowSlots = new Set();

      if (defaultRoute) {
        presets = upsertWorkflowPreset(presets, 'lead', defaultRoute);
        workflowRoutes.lead = defaultRoute;
        nextConfig.default = workflowPresetId('lead');
      }

      for (const slot of WORKFLOW_ROUTE_SLOTS) {
        const normalized = normalizeWorkflowRoute(workflowInput[slot]);
        if (!normalized) continue;
        workflowRoutes[slot] = normalized;
        presets = upsertWorkflowPreset(presets, slot, normalized);
        touchedWorkflowSlots.add(slot);
      }

      nextConfig.presets = presets;
      nextConfig.workflowRoutes = workflowRoutes;
      nextConfig.maintenance = {
        ...(nextConfig.maintenance || {}),
        ...(touchedWorkflowSlots.has('explorer') ? { explore: normalizeWorkflowRoute(workflowRoutes.explorer) } : {}),
        ...(touchedWorkflowSlots.has('memory') ? { memory: normalizeWorkflowRoute(workflowRoutes.memory) } : {}),
      };
      const agentInput = payload.agentRoutes && typeof payload.agentRoutes === 'object'
        ? payload.agentRoutes
        : null;
      if (agentInput) {
        const nextAgents = { ...(nextConfig.agents || {}) };
        const nextMaintenance = { ...(nextConfig.maintenance || {}) };
        for (const agent of FIXED_AGENT_SLOTS) {
          const routeToSave = normalizeWorkflowRoute(agentInput[agent.id]);
          if (!routeToSave) continue;
          nextAgents[agent.id] = routeToSave;
          presets = upsertWorkflowPreset(presets, agentPresetSlot(agent.id), routeToSave);
          if (agent.workflowSlot) {
            workflowRoutes[agent.workflowSlot] = routeToSave;
            presets = upsertWorkflowPreset(presets, agent.workflowSlot, routeToSave);
            if (agent.id === 'explore') nextMaintenance.explore = routeToSave;
            if (agent.id === 'maintainer') nextMaintenance.memory = routeToSave;
          }
        }
        nextConfig.agents = nextAgents;
        nextConfig.presets = presets;
        nextConfig.workflowRoutes = workflowRoutes;
        nextConfig.maintenance = nextMaintenance;
      }
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
      };

      if (payload.searchRoute) {
        const searchToSave = normalizeSearchRouteConfig(payload.searchRoute);
        if (searchToSave) nextConfig.searchRoute = searchToSave;
      }

      saveConfigAndAdopt(nextConfig);
      if (defaultRoute) {
        setRouteState(resolveRoute(getConfig(), { provider: defaultRoute.provider, model: defaultRoute.model, effort: defaultRoute.effort }));
        const session = getSession();
        if (session?.id) mgr.closeSession(session.id, 'cli-onboarding-complete', { tombstone: tombstoneOnClose(session) });
        await recreateCurrentSessionIfReady();
      }
      return this.getOnboardingStatus();
    },
    listAgents() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const config = getConfig();
      return FIXED_AGENT_SLOTS.map((agent) => ({
        ...agent,
        locked: true,
        route: agentRouteFromConfig(config, agent.id, dataDir),
        definition: loadAgentDefinition(dataDir, agent.id),
      }));
    },
    listWorkflows() {
      const currentConfig = displayConfig();
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const active = activeWorkflowId(currentConfig);
      return listWorkflowPacks(dataDir).map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        source: workflow.source,
        active: workflow.id === active,
        agents: workflow.agents,
      }));
    },
    getOutputStyle() {
      return getOutputStyleStatusCached();
    },
    listOutputStyles() {
      return getOutputStyleStatusCached();
    },
    async setOutputStyle(value) {
      const before = getOutputStyleStatusCached({ fresh: true });
      const selected = findOutputStyle(value, before.styles);
      if (!selected) {
        const names = before.styles.map((style) => style.label || style.id).join(', ') || 'Default';
        throw new Error(`output style must be one of ${names}`);
      }
      // Adopt in-memory immediately so same-tick readers see the new style;
      // persist off the key-handler tick via the flushOutputStyleSave debounce.
      const nextConfig = { ...getConfig(), outputStyle: selected.id };
      if (nextConfig.agent && typeof nextConfig.agent === 'object' && !Array.isArray(nextConfig.agent)) {
        const agent = { ...nextConfig.agent };
        delete agent.outputStyle;
        nextConfig.agent = agent;
      }
      adoptConfig(nextConfig);
      scheduleOutputStyleSave(selected.id);
      const freshStatus = { configured: selected.id, current: selected, styles: before.styles };
      seedOutputStyleStatusCache(freshStatus);
      const session = getSession();
      const hasConversation = sessionHasConversationMessages(session);
      let appliedToCurrentSession = !hasConversation;
      if (session?.id && !hasConversation) {
        const closedSessionId = session.id;
        mgr.closeSession(closedSessionId, 'cli-output-style-switch');
        setSession(null);
        setTimeout(() => {
          recreateCurrentSessionIfReady().catch((err) => {
            try {
              notifyFnForSession(closedSessionId)(
                `Failed to start a new session after output style change: ${err?.message || err}`,
                { level: 'error' },
              );
            } catch {}
          });
        }, 0);
      }
      invalidateContextStatusCache();
      return { ...freshStatus, appliedToCurrentSession };
    },
    async setWorkflow(workflowId) {
      const id = normalizeWorkflowId(workflowId, DEFAULT_WORKFLOW_ID);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, id);
      if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
      const nextConfig = { ...getConfig() };
      nextConfig.workflow = { ...(nextConfig.workflow || {}), active: id };
      saveConfigAndAdopt(nextConfig);
      return workflowSummary(pack);
    },
    async setAgentRoute(agentId, next) {
      const id = normalizeAgentId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      let selectedRoute = resolveRoute(getConfig(), { ...(next || {}) });
      await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });

      const routeToSave = normalizeWorkflowRoute(selectedRoute);
      if (!routeToSave) throw new Error('agent route requires provider and model');
      const agent = FIXED_AGENT_SLOTS.find((item) => item.id === id);
      const nextConfig = { ...getConfig() };
      nextConfig.agents = {
        ...(nextConfig.agents || {}),
        [id]: routeToSave,
      };
      nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, agentPresetSlot(id), routeToSave);
      if (agent?.workflowSlot) {
        nextConfig.workflowRoutes = {
          ...(nextConfig.workflowRoutes || {}),
          [agent.workflowSlot]: routeToSave,
        };
        nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, agent.workflowSlot, routeToSave);
        nextConfig.maintenance = {
          ...(nextConfig.maintenance || {}),
          ...(id === 'explore' ? { explore: routeToSave } : {}),
          ...(id === 'maintainer' ? { memory: routeToSave } : {}),
        };
      }
      saveConfigAndAdopt(nextConfig);
      return routeToSave;
    },
  };
}
