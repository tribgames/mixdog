import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { clean } from '../session-text.mjs';
import { hasOwn } from '../../runtime/shared/object.mjs';
import { serializeFrontmatterDoc } from '../../runtime/shared/markdown-frontmatter.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';
import { AGENT_DELETED_MARKER, FIXED_AGENT_SLOTS, availableAgentId, clearAgentDefinitionCache } from '../workflow.mjs';
import { canonicalizeAgentRouteStorage, isAgentDisabled } from '../../runtime/shared/agent-route-config.mjs';
import { agentEditorId, effectiveAgentRoute, oneLine, resolveDataDir } from './shared.mjs';

const isFixedAgent = (id) => FIXED_AGENT_SLOTS.some((agent) => agent.id === id);
const hasUserAgentFile = (dataDir, id) => existsSync(join(dataDir, 'agents', id, 'AGENT.md'));

function writeAgentFiles(dir, { name, description, body }) {
  const meta = { name, ...(description ? { description } : {}) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), serializeFrontmatterDoc(meta, body));
  // loadAgentDefinition prefers the manifest for name/description.
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify(meta, null, 2)}\n`);
  rmSync(join(dir, AGENT_DELETED_MARKER), { force: true });
}

// Agent catalog + editor surface: fixed services stay built-in; starter and
// user-authored agents are custom definitions under agents/<id>/AGENT.md.
export function createAgentEditorApi(deps) {
  const { getConfig, loadAgentDefinition, listCustomAgentIds, saveConfigAndAdopt, setAgentRoute } = deps;
  const routeFor = (config, id) => effectiveAgentRoute(deps, config, id);

  function listAgents() {
    const dataDir = resolveDataDir(deps);
    const config = getConfig();
    const fixed = FIXED_AGENT_SLOTS.map((agent) => ({
      ...agent,
      locked: true,
      userOverride: hasUserAgentFile(dataDir, agent.id),
      route: routeFor(config, agent.id),
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
        userOverride: hasUserAgentFile(dataDir, id),
        route: routeFor(config, id),
        disabled: isAgentDisabled(config, id),
        definition,
      };
    });
    return [...fixed, ...custom];
  }

  function getAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    // Internal hidden roles are Mixdog-managed and never editable here.
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
    const dataDir = resolveDataDir(deps);
    const definition = loadAgentDefinition(dataDir, id);
    if (!definition) throw new Error(`agent "${agentId}" not found`);
    return {
      id,
      name: definition.name,
      description: definition.description,
      body: definition.body,
      custom: !isFixedAgent(id),
      userOverride: hasUserAgentFile(dataDir, id),
      route: routeFor(getConfig(), id),
      disabled: isAgentDisabled(getConfig(), id),
    };
  }

  function resolveSaveTarget(payload, dataDir) {
    const id = agentEditorId(clean(payload.id));
    if (hasOwn(payload, 'id') && !id) {
      throw new Error('agent id must contain letters/numbers (dashes and dots allowed)');
    }
    if (id && isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be edited`);
    const name = oneLine(payload.name);
    if (!name && !id) throw new Error('agent name must not be empty');
    return {
      id: id || availableAgentId(name, (candidate) => Boolean(loadAgentDefinition(dataDir, candidate))),
      name,
      description: oneLine(payload.description),
    };
  }

  async function saveAgentDefinition(payload = {}) {
    const body = String(payload.body || '').trim();
    if (!body) throw new Error('AGENT.md body must not be empty');
    const dataDir = resolveDataDir(deps);
    const { id, name, description } = resolveSaveTarget(payload, dataDir);
    writeAgentFiles(join(dataDir, 'agents', id), { name: name || id, description, body });
    clearAgentDefinitionCache(id);
    if (payload.route) await setAgentRoute(id, payload.route);
    return getAgentDefinition(id);
  }

  // A removed custom agent must not leave a dangling route/preset.
  function dropAgentRoute(id) {
    const nextConfig = { ...getConfig() };
    if (nextConfig.agents && id in nextConfig.agents) {
      const agents = { ...nextConfig.agents };
      delete agents[id];
      nextConfig.agents = agents;
    }
    saveConfigAndAdopt(canonicalizeAgentRouteStorage(nextConfig));
  }

  async function deleteAgentDefinition(agentId) {
    const id = agentEditorId(agentId);
    if (!id) throw new Error(`unknown agent "${agentId}"`);
    if (isHiddenAgent(id)) throw new Error(`agent "${id}" is internal and cannot be deleted`);
    const builtIn = isFixedAgent(id);
    const dataDir = resolveDataDir(deps);
    const dir = join(dataDir, 'agents', id);
    if (!hasUserAgentFile(dataDir, id)) {
      if (builtIn) throw new Error(`agent "${id}" has no user override to reset`);
      if (!loadAgentDefinition(dataDir, id)) throw new Error(`agent "${id}" not found`);
    }
    // Agents are global (no workflow rosters): deleting a custom agent removes
    // it from every surface at once — catalog, editor, routes, and spawn (the
    // spawn path rejects unknown agent ids).
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
    if (!builtIn) dropAgentRoute(id);
    return { id, deleted: true, revertedToBuiltIn: builtIn && Boolean(sourceFallback) };
  }

  return { listAgents, getAgentDefinition, saveAgentDefinition, deleteAgentDefinition };
}
