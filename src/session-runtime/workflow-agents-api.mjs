import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { clean, hasOwn, sessionHasConversationMessages, tombstoneOnClose } from './session-text.mjs';
import { isKnownProvider } from '../standalone/provider-admin.mjs';
import { serializeFrontmatterDoc } from '../runtime/shared/markdown-frontmatter.mjs';
import { isHiddenAgent } from '../runtime/agent/orchestrator/internal-agents.mjs';
import {
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  workflowPresetId,
  WORKFLOW_ROUTE_SLOTS,
  FIXED_AGENT_SLOTS,
  agentPresetSlot,
  normalizeAgentId,
  normalizeWorkflowId,
  workflowIdFromName,
  availableWorkflowId,
  availableAgentId,
  DEFAULT_WORKFLOW_ID,
  normalizeSearchRouteConfig,
  clearAgentDefinitionCache,
} from './workflow.mjs';
import { ONBOARDING_VERSION } from './quick-search-models.mjs';
import { findOutputStyle } from './output-styles.mjs';
import { ensureProviderEnabled } from './config-helpers.mjs';
import { fastCapableFor } from './model-capabilities.mjs';

// Onboarding + agents/workflows/output-style selection surface. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live getters/setters for the mutable config/route/
// session locals plus the closure callbacks.
export function createWorkflowAgentsApi(deps) {
  const {
    getConfig, getRoute, setRouteState, getSession, setSession,
    cfgMod, reg, mgr, STANDALONE_DATA_DIR,
    resolveRoute, lookupModelMeta, adoptConfig, saveConfigAndAdopt, displayConfig, ensureProvidersReady,
    agentRouteFromConfig, loadAgentDefinition, activeWorkflowId, listWorkflowPacks,
    loadWorkflowPack, workflowSummary, listCustomAgentIds,
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
      const fixed = FIXED_AGENT_SLOTS.map((agent) => ({
        ...agent,
        locked: true,
        userOverride: existsSync(join(dataDir, 'agents', agent.id, 'AGENT.md')),
        route: agentRouteFromConfig(config, agent.id, dataDir),
        definition: loadAgentDefinition(dataDir, agent.id),
      }));
      // Custom agents (user-authored roles): discovered from agents/<id>/
      // AGENT.md directories beyond the fixed slots.
      const custom = (listCustomAgentIds?.(dataDir) || []).map((id) => {
        const definition = loadAgentDefinition(dataDir, id);
        return {
          id,
          label: definition?.name || id,
          description: definition?.description || '',
          custom: true,
          userOverride: existsSync(join(dataDir, 'agents', id, 'AGENT.md')),
          route: agentRouteFromConfig(config, id, dataDir),
          definition,
        };
      });
      return [...fixed, ...custom];
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
        // Distinguishes "agents: (empty) = Lead only" from "no agents key =
        // all fixed agents" for surfaces that render the pack's agent set.
        agentsConfigured: workflow.agentsConfigured === true,
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
    // Workflow editor surface (desktop Workflows page): full pack read/write.
    // User packs live at <dataDir>/workflows/<id>/WORKFLOW.md; saving a
    // built-in id writes a user override, deleting the override reverts it.
    getWorkflowPack(workflowId) {
      const id = normalizeWorkflowId(workflowId, '');
      if (!id) throw new Error(`unknown workflow "${workflowId}"`);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, id);
      if (!pack || pack.id !== id) throw new Error(`workflow "${workflowId}" not found`);
      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        source: pack.source,
        agentsConfigured: pack.agentsConfigured === true,
        agents: pack.agents,
        body: pack.body,
        userOverride: existsSync(join(dataDir, 'workflows', id, 'WORKFLOW.md')),
      };
    },
    async saveWorkflowPack(payload = {}) {
      const id = normalizeWorkflowId(payload.id, '');
      if (!id) throw new Error('workflow id must contain letters/numbers (dashes and dots allowed)');
      const body = String(payload.body || '').trim();
      if (!body) throw new Error('WORKFLOW.md body must not be empty');
      // Frontmatter values are single-line by format; collapse any newlines.
      const oneLine = (value) => clean(value).replace(/\s+/g, ' ');
      const name = oneLine(payload.name) || id;
      const description = oneLine(payload.description);
      // agents: null/absent keeps the pack on "all agents" (no frontmatter key).
      const agents = Array.isArray(payload.agents)
        ? [...new Set(payload.agents
            .map((agent) => normalizeAgentId(agent) || normalizeWorkflowId(agent))
            .filter(Boolean))]
        : null;
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const dir = join(dataDir, 'workflows', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'WORKFLOW.md'), serializeFrontmatterDoc({
        id,
        name,
        ...(description ? { description } : {}),
        ...(agents ? { agents: agents.join(', ') } : {}),
      }, body));
      return this.getWorkflowPack(id);
    },
    async createWorkflow(payload = {}) {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const name = clean(payload.name).replace(/\s+/g, ' ');
      if (!name) throw new Error('workflow name must not be empty');
      const requestedId = normalizeWorkflowId(payload.id, '');
      if (requestedId) {
        const existing = loadWorkflowPack(dataDir, requestedId);
        if (existing && existing.id === requestedId) throw new Error(`workflow "${requestedId}" already exists`);
        return this.saveWorkflowPack({ ...payload, id: requestedId, name });
      }
      const id = availableWorkflowId(workflowIdFromName(name), (candidate) => {
        const existing = loadWorkflowPack(dataDir, candidate);
        return Boolean(existing && existing.id === candidate);
      });
      return this.saveWorkflowPack({ ...payload, id, name });
    },
    async deleteWorkflow(workflowId) {
      const id = normalizeWorkflowId(workflowId, '');
      if (!id) throw new Error(`unknown workflow "${workflowId}"`);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const pack = loadWorkflowPack(dataDir, id);
      if (!pack || pack.id !== id) throw new Error(`workflow "${id}" not found`);
      const dir = join(dataDir, 'workflows', id);
      if (!existsSync(join(dir, 'WORKFLOW.md'))) {
        throw new Error(`workflow "${id}" is built-in and cannot be deleted`);
      }
      rmSync(dir, { recursive: true, force: true });
      const remaining = loadWorkflowPack(dataDir, id);
      const revertedToBuiltIn = Boolean(remaining && remaining.id === id);
      // A fully-removed pack must not stay active; fall back to Default.
      if (!revertedToBuiltIn && activeWorkflowId(getConfig()) === id) {
        const nextConfig = { ...getConfig() };
        nextConfig.workflow = { ...(nextConfig.workflow || {}), active: DEFAULT_WORKFLOW_ID };
        saveConfigAndAdopt(nextConfig);
      }
      return { id, deleted: true, revertedToBuiltIn };
    },
    // Agent editor surface (desktop Workflows page): the fixed roles stay
    // built-in; custom agents are user-authored under <dataDir>/agents/<id>/.
    getAgentDefinition(agentId) {
      const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      // Internal hidden roles (scheduler-task, webhook-handler, …) are
      // Mixdog-managed and never editable through the agent surface.
      if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const definition = loadAgentDefinition(dataDir, id);
      if (!definition) throw new Error(`agent "${agentId}" not found`);
      return {
        id,
        name: definition.name,
        description: definition.description,
        body: definition.body,
        custom: !FIXED_AGENT_SLOTS.some((agent) => agent.id === id),
        userOverride: existsSync(join(dataDir, 'agents', id, 'AGENT.md')),
        route: agentRouteFromConfig(getConfig(), id, dataDir),
      };
    },
    async saveAgentDefinition(payload = {}) {
      const body = String(payload.body || '').trim();
      if (!body) throw new Error('AGENT.md body must not be empty');
      const oneLine = (value) => clean(value).replace(/\s+/g, ' ');
      const requestedId = clean(payload.id);
      let id = normalizeAgentId(requestedId) || normalizeWorkflowId(requestedId);
      if (hasOwn(payload, 'id') && !id) {
        throw new Error('agent id must contain letters/numbers (dashes and dots allowed)');
      }
      if (id && isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
      const name = oneLine(payload.name);
      if (!name && !id) throw new Error('agent name must not be empty');
      const description = oneLine(payload.description);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      if (!id) {
        id = availableAgentId(name, (candidate) => Boolean(loadAgentDefinition(dataDir, candidate)));
      }
      const dir = join(dataDir, 'agents', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENT.md'), serializeFrontmatterDoc({
        name: name || id,
        ...(description ? { description } : {}),
      }, body));
      // loadAgentDefinition prefers the manifest for name/description.
      writeFileSync(join(dir, 'agent.json'), `${JSON.stringify({
        name: name || id,
        ...(description ? { description } : {}),
      }, null, 2)}\n`);
      clearAgentDefinitionCache(id);
      if (payload.route) {
        await this.setAgentRoute(id, payload.route);
      } else if (!FIXED_AGENT_SLOTS.some((agent) => agent.id === id)
        && !agentRouteFromConfig(getConfig(), id, dataDir)) {
        // Custom roles have no built-in preset fallback, so a model-less save
        // would spawn as `agent "<id>" has no model assignment`. Seed the
        // current default route; an unconfigured install just stays routeless.
        try { await this.setAgentRoute(id, {}); } catch { /* no default route yet */ }
      }
      return this.getAgentDefinition(id);
    },
    async deleteAgentDefinition(agentId) {
      const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be deleted`);
      const builtIn = FIXED_AGENT_SLOTS.some((agent) => agent.id === id);
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const dir = join(dataDir, 'agents', id);
      // Built-in roles are never removed: dropping their user override reverts
      // the role to the shipped AGENT.md, mirroring workflow-pack deletes.
      if (!existsSync(join(dir, 'AGENT.md'))) {
        throw new Error(builtIn
          ? `agent "${id}" has no user override to reset`
          : `agent "${id}" not found`);
      }
      // Custom definitions are hard references from explicit workflow agent
      // lists. Refuse deletion instead of leaving a pack that fails only when
      // it next tries to delegate.
      if (!builtIn) {
        const workflowNames = listWorkflowPacks(dataDir)
          .filter((workflow) => workflow.agentsConfigured === true
            && Array.isArray(workflow.agents)
            && workflow.agents.includes(id))
          .map((workflow) => workflow.name || workflow.id);
        if (workflowNames.length) {
          throw new Error(
            `agent "${id}" is used by ${workflowNames.length === 1 ? 'workflow' : 'workflows'}: `
            + `${workflowNames.join(', ')}. Remove it from those workflows before deleting it`,
          );
        }
      }
      rmSync(dir, { recursive: true, force: true });
      clearAgentDefinitionCache(id);
      const revertedToBuiltIn = Boolean(loadAgentDefinition(dataDir, id));
      // A fully-removed custom agent must not leave a dangling route/preset.
      if (!revertedToBuiltIn) {
        const nextConfig = { ...getConfig() };
        if (nextConfig.agents && id in nextConfig.agents) {
          const agents = { ...nextConfig.agents };
          delete agents[id];
          nextConfig.agents = agents;
        }
        const presetId = workflowPresetId(agentPresetSlot(id));
        nextConfig.presets = (Array.isArray(nextConfig.presets) ? nextConfig.presets : [])
          .filter((preset) => clean(preset?.id) !== presetId);
        saveConfigAndAdopt(nextConfig);
      }
      return { id, deleted: true, revertedToBuiltIn };
    },
    async setAgentRoute(agentId, next) {
      // Custom agents keep their workflow-style id; routes persist in
      // config.agents[<id>] exactly like the fixed roles.
      const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and has no configurable route`);
      // Route-scope isolation: an agent route owns its model AND its
      // effort/fast, stored in config.agents[<id>]. The shared
      // config.modelSettings[provider/model] bucket belongs to the MAIN route
      // alone (setRoute/setFast/setEffort) — resolveRoute reads it with
      // priority over the lead preset, so an agent that reused it silently
      // rewrote Main's effort/fast for the next session. Read the agent's own
      // stored route as the fallback instead, and never write the bucket here.
      const requested = { ...(next || {}) };
      const routeDataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const stored = agentRouteFromConfig(getConfig(), id, routeDataDir) || {};
      // A request with neither provider nor model is the "seed from the current
      // default" path (new custom agent) and inherits Main verbatim.
      const inheritsDefault = !clean(requested.provider) && !clean(requested.model);
      let selectedRoute = resolveRoute(getConfig(), requested);
      if (!inheritsDefault) {
        const sameModel = clean(selectedRoute.provider) === clean(stored.provider)
          && clean(selectedRoute.model) === clean(stored.model);
        selectedRoute = {
          ...selectedRoute,
          effort: requested.effort !== undefined
            ? selectedRoute.effort
            : (sameModel ? (stored.effort || null) : null),
          fast: requested.fast !== undefined
            ? selectedRoute.fast === true
            : (sameModel && stored.fast === true),
        };
      }
      await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };

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
