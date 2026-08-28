import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { clean, hasOwn } from './session-text.mjs';
import { serializeFrontmatterDoc } from '../runtime/shared/markdown-frontmatter.mjs';
import { isHiddenAgent } from '../runtime/agent/orchestrator/internal-agents.mjs';
import {
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  workflowPresetId,
  WORKFLOW_ROUTE_SLOTS,
  AGENT_DELETED_MARKER,
  FIXED_AGENT_SLOTS,
  normalizeAgentId,
  normalizeWorkflowId,
  workflowIdFromName,
  availableWorkflowId,
  availableAgentId,
  DEFAULT_WORKFLOW_ID,
  normalizeWebSearchRouteConfig,
  clearAgentDefinitionCache,
} from './workflow.mjs';
import { ONBOARDING_VERSION } from './quick-web-search-models.mjs';
import { findOutputStyle } from './output-styles.mjs';
import { ensureProviderEnabled } from './config-helpers.mjs';
import { fastCapableFor } from './model-capabilities.mjs';
import {
  canonicalizeAgentRouteStorage,
  isAgentDisabled,
  withAgentDisabled,
} from '../runtime/shared/agent-route-config.mjs';

// Onboarding + agents/workflows/output-style selection surface. Extracted
// verbatim from the runtime API object; stateless helpers are imported directly
// and the runtime injects live getters/setters for the mutable config/route/
// session locals plus the closure callbacks.
export function createWorkflowAgentsApi(deps) {
  const {
    getConfig, getRoute, setRouteState, getSession,
    cfgMod, STANDALONE_DATA_DIR,
    resolveRoute, lookupModelMeta, adoptConfig, saveConfigAndAdopt, displayConfig, ensureProvidersReady,
    agentRouteFromConfig, loadAgentDefinition, activeWorkflowId, listWorkflowPacks,
    loadWorkflowPack, workflowSummary, listCustomAgentIds,
    getOutputStyleStatusCached, seedOutputStyleStatusCache, scheduleOutputStyleSave,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface, refreshEmptySessionToolPolicy,
  } = deps;
  return {
    async completeOnboarding(payload = {}) {
      // Only fall back to the live runtime route when the caller actually sent a
      // defaultRoute. The onboarding "partial save" path (Main left unset, only
      // Web Search/agent picks) omits defaultRoute entirely and must NOT persist the
      // current route as Main or recreate the session.
      const config = getConfig();
      const workflowInput = payload.workflowRoutes && typeof payload.workflowRoutes === 'object'
        ? payload.workflowRoutes
        : {};
      const nextConfig = { ...config };
      const defaultRoute = hasOwn(payload, 'defaultRoute')
        ? normalizeWorkflowRoute(payload.defaultRoute, getRoute())
        : null;
      let presets = Array.isArray(nextConfig.presets) ? nextConfig.presets.slice() : [];
      const agentRoutes = { ...(nextConfig.agents || {}) };

      if (defaultRoute) {
        presets = upsertWorkflowPreset(presets, 'lead', defaultRoute);
        nextConfig.default = workflowPresetId('lead');
      }

      for (const slot of WORKFLOW_ROUTE_SLOTS) {
        if (!hasOwn(workflowInput, slot)) continue;
        const normalized = normalizeWorkflowRoute(workflowInput[slot]);
        if (slot === 'lead') {
          if (!normalized) continue;
          presets = upsertWorkflowPreset(presets, 'lead', normalized);
          nextConfig.default = workflowPresetId('lead');
        } else if (slot === 'agent') {
          if (normalized) agentRoutes.worker = normalized;
          else delete agentRoutes.worker;
        } else if (slot === 'memory') {
          if (normalized) agentRoutes.maintainer = normalized;
          else delete agentRoutes.maintainer;
        }
      }

      nextConfig.presets = presets;
      nextConfig.agents = agentRoutes;
      const agentInput = payload.agentRoutes && typeof payload.agentRoutes === 'object'
        ? payload.agentRoutes
        : null;
      if (agentInput) {
        const nextAgents = { ...agentRoutes };
        const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
        const configurableIds = new Set([
          ...FIXED_AGENT_SLOTS.map((agent) => agent.id),
          ...(listCustomAgentIds?.(dataDir) || []),
        ]);
        for (const id of configurableIds) {
          if (!hasOwn(agentInput, id)) continue;
          const routeToSave = normalizeWorkflowRoute(agentInput[id]);
          if (routeToSave) nextAgents[id] = routeToSave;
          else delete nextAgents[id];
        }
        nextConfig.agents = nextAgents;
      }
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
      };

      if (payload.webSearchRoute) {
        const webSearchToSave = clean(payload.webSearchRoute.provider)
          ? normalizeWebSearchRouteConfig(payload.webSearchRoute)
          : normalizeWebSearchRouteConfig({ provider: 'default', model: 'default', toolType: payload.webSearchRoute.toolType });
        if (webSearchToSave) nextConfig.webSearchRoute = webSearchToSave;
      }

      saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
      if (defaultRoute) {
        setRouteState(resolveRoute(getConfig(), { provider: defaultRoute.provider, model: defaultRoute.model, effort: defaultRoute.effort }));
        invalidatePreSessionToolSurface?.();
      }
      return this.getOnboardingStatus();
    },
    listAgents() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const config = getConfig();
      // Agents have two states only (a model, or off), so an agent that has
      // never been pinned reports the effective Main route instead of an empty
      // one — the surfaces must never offer a third "follows Main" state.
      const effectiveRoute = (agentId) => agentRouteFromConfig(config, agentId)
        || normalizeWorkflowRoute(resolveRoute(config, {}));
      const fixed = FIXED_AGENT_SLOTS.map((agent) => ({
        ...agent,
        locked: true,
        userOverride: existsSync(join(dataDir, 'agents', agent.id, 'AGENT.md')),
        route: effectiveRoute(agent.id),
        disabled: isAgentDisabled(config, agent.id),
        definition: loadAgentDefinition(dataDir, agent.id),
      }));
      // Starter and user-authored custom agents are discovered from
      // agents/<id>/AGENT.md directories beyond the fixed services.
      const custom = (listCustomAgentIds?.(dataDir) || []).map((id) => {
        const definition = loadAgentDefinition(dataDir, id);
        return {
          id,
          label: definition?.name || id,
          description: definition?.description || '',
          custom: true,
          userOverride: existsSync(join(dataDir, 'agents', id, 'AGENT.md')),
          route: effectiveRoute(id),
          disabled: isAgentDisabled(config, id),
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
        // Delegation on/off is the only agent-related pack surface left:
        // agents are global, packs never carry a roster.
        delegatesAgents: workflow.delegatesAgents !== false,
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
      // Output style is global configuration for future turns/sessions. Never
      // replace an addressed session merely to rebuild its frozen prompt.
      const appliedToCurrentSession = !getSession()?.id;
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
      const applied = await refreshEmptySessionToolPolicy?.();
      invalidatePreSessionToolSurface?.();
      return { ...workflowSummary(pack), appliedToCurrentSession: applied?.appliedToCurrentSession !== false };
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
        delegatesAgents: pack.delegatesAgents !== false,
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
      // Delegation on/off replaces the legacy `agents` roster payload: only an
      // explicit "none" writes frontmatter; anything else means "delegates".
      const delegation = String(payload.delegation ?? '').trim().toLowerCase();
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const dir = join(dataDir, 'workflows', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'WORKFLOW.md'), serializeFrontmatterDoc({
        id,
        name,
        ...(description ? { description } : {}),
        ...(delegation === 'none' ? { delegation: 'none' } : {}),
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
    // Agent editor surface: fixed services stay built-in; starter and
    // user-authored agents are custom definitions.
    getAgentDefinition(agentId) {
      const id = normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
      if (!id) throw new Error(`unknown agent "${agentId}"`);
      // Internal hidden roles are Mixdog-managed and never editable here.
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
        route: agentRouteFromConfig(getConfig(), id)
          || normalizeWorkflowRoute(resolveRoute(getConfig(), {})),
        disabled: isAgentDisabled(getConfig(), id),
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
      rmSync(join(dir, AGENT_DELETED_MARKER), { force: true });
      clearAgentDefinitionCache(id);
      if (payload.route) {
        await this.setAgentRoute(id, payload.route);
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
      const hasUserDefinition = existsSync(join(dir, 'AGENT.md'));
      const currentDefinition = loadAgentDefinition(dataDir, id);
      if (!hasUserDefinition) {
        if (builtIn) throw new Error(`agent "${id}" has no user override to reset`);
        if (!currentDefinition) throw new Error(`agent "${id}" not found`);
      }
      // Agents are global (no workflow rosters): deleting a custom agent
      // removes it from every surface at once — catalog, editor, routes, and
      // spawn (the spawn path rejects unknown agent ids).
      rmSync(dir, { recursive: true, force: true });
      clearAgentDefinitionCache(id);
      const sourceFallback = loadAgentDefinition(dataDir, id);
      // Shipped starter agents are custom, not fixed. Persist an explicit
      // tombstone so deleting one does not fall back to the packaged copy.
      if (!builtIn && sourceFallback) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, AGENT_DELETED_MARKER), 'deleted\n');
        clearAgentDefinitionCache(id);
      }
      // A removed custom agent must not leave a dangling route/preset.
      if (!builtIn) {
        const nextConfig = { ...getConfig() };
        if (nextConfig.agents && id in nextConfig.agents) {
          const agents = { ...nextConfig.agents };
          delete agents[id];
          nextConfig.agents = agents;
        }
        saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
      }
      return { id, deleted: true, revertedToBuiltIn: builtIn && Boolean(sourceFallback) };
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
      const stored = agentRouteFromConfig(getConfig(), id) || {};
      // Off is an explicit state, stored apart from the route so the model the
      // user picked survives and comes back when the agent is switched on.
      if (requested.disabled === true) {
        saveConfigAndAdopt(canonicalizeAgentRouteStorage(withAgentDisabled(getConfig(), id, true)));
        return { ...(stored || {}), id, disabled: true };
      }
      // No provider means no explicit override. Remove the stored route so the
      // agent follows Main dynamically; never synthesize a provider.
      if (!clean(requested.provider)) {
        const nextConfig = { ...getConfig() };
        const agents = { ...(nextConfig.agents || {}) };
        const hadOverride = Object.prototype.hasOwnProperty.call(agents, id);
        delete agents[id];
        nextConfig.agents = agents;
        if (hadOverride) saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
        const inherited = normalizeWorkflowRoute(resolveRoute(getConfig(), {}));
        return { ...(inherited || {}), inherited: true };
      }
      if (!clean(requested.model)) throw new Error('agent route requires provider and model');
      let selectedRoute = resolveRoute(getConfig(), requested);
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
        modelParameters: requested.modelParameters !== undefined
          ? selectedRoute.modelParameters
          : (sameModel ? (stored.modelParameters || {}) : {}),
      };
      await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      const fastCapable = fastCapableFor(
        selectedRoute.provider,
        modelMeta,
        selectedRoute.effort,
        selectedRoute.modelParameters,
      );
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };

      const routeToSave = normalizeWorkflowRoute(selectedRoute);
      if (!routeToSave) throw new Error('agent route requires provider and model');
      // Picking a model is also the "on" switch — the two states are exclusive.
      const nextConfig = withAgentDisabled(getConfig(), id, false);
      nextConfig.agents = {
        ...(nextConfig.agents || {}),
        [id]: routeToSave,
      };
      saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
      return routeToSave;
    },
  };
}
