import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertConnectorPolicyNotWidened,
  CONNECTOR_PERMISSIONS,
  connectorEnabled,
  connectorGroupId,
  connectorToolEntries,
  connectorToolPermission,
  DENY_ALL_CONNECTORS,
  migrateLegacyConnectorPolicy,
  NO_WIDEN_MESSAGE,
  PROJECT_CONNECTORS_FILE,
  parseConnectorPolicy,
  readProjectConnectorsFile,
  setConnectorToolPermissionWriter,
  storedConnectorPolicy,
} from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import {
  cwdWithinProjects,
  extensionScopesFromConfig,
  withExtensionScope,
} from '../../runtime/shared/extension-scopes.mjs';
import { withFileLockSync, writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { listProjectsStrict } from '../../runtime/shared/projects.mjs';
import { isSelfMcpToolName, parseMcpToolName } from '../../runtime/shared/tool-primitives.mjs';
import { resolveDataDir } from './shared.mjs';

const samePath = (left, right) => cwdWithinProjects(left, [right]) && cwdWithinProjects(right, [left]);
const PLUGIN_REGISTRY_WARNING = /^plugin MCP servers unavailable/;

// Host-only surface for the connector switches ("사용할 커넥터"): the global
// MCP servers (with their sign-in state), and per agent and per project which
// of them are on. Every installed connector is on unless switched off there.
// Agent policies go through the agent editor, which keeps every other
// agent.json key; project policies live in <data>/project-connectors.json,
// keyed by the registered Project path.
export function createAgentConnectorsApi(deps, editor) {
  const {
    mcpStatus,
    getMcpTools,
    getConfig,
    saveConfigAndAdopt,
    resolveConfiguredMcpCatalog,
    listProjects = listProjectsStrict,
  } = deps;
  const dataDir = () => resolveDataDir(deps);
  const projectFile = () => join(dataDir(), PROJECT_CONNECTORS_FILE);
  const installedIds = () => listConnectors().map(({ id }) => id);
  const switches = (policy) => installedIds().map((id) => ({ id, enabled: connectorEnabled(policy, id) }));
  // A legacy list or an unreadable policy becomes its deny-list equivalent
  // over today's connectors before any edit, so an edit never widens it.
  const editablePolicy = (agentId) =>
    migrateLegacyConnectorPolicy(editor.getAgentConnectorPolicy(agentId), installedIds()) || { off: [], tools: {} };

  function listConnectors() {
    return (mcpStatus()?.servers || []).map((row) => ({
      id: row.name,
      enabled: row.enabled !== false,
      status: row.status,
      connected: row.connected === true,
      authRequired: row.authRequired === true,
      signedIn: row.oauth ? row.oauth.signedIn === true : null,
      transport: row.transport,
      toolCount: row.toolCount || 0,
      source: row.source,
      ...(row.error ? { error: row.error } : {}),
    }));
  }

  // `readOnly` is the server's own `readOnlyHint` (null when it gives none).
  function listConnectorTools(connectorId) {
    return (getMcpTools() || [])
      .filter((tool) => !isSelfMcpToolName(tool) && parseMcpToolName(tool)?.server === connectorId)
      .map((tool) => {
        const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
        return {
          name: parseMcpToolName(tool).tool,
          description: tool.description || '',
          annotations,
          readOnly: typeof annotations.readOnlyHint === 'boolean' ? annotations.readOnlyHint : null,
        };
      });
  }

  const requireId = (value, label) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id) throw new Error(`${label} is required`);
    return id;
  };

  /** `[{ id, enabled }]`: each installed connector and whether the agent may use it. */
  function getAgentConnectors(agentId) {
    return switches(editor.getAgentConnectorPolicy(agentId));
  }

  /** Switch one connector on or off for the agent; returns its switches.
   *  `options.noWiden` (set by the host for a remote client, never by a caller's
   *  payload) refuses a change that gives the agent more authority; it is judged
   *  against the stored policy in the same synchronous stretch as the write, so
   *  a restriction landing meanwhile is never overwritten. */
  async function setAgentConnectorEnabled(agentId, connectorId, enabled, options) {
    const id = requireId(connectorId, 'connector id');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const policy = editablePolicy(agentId);
    const off = enabled ? policy.off.filter((entry) => entry !== id) : [...policy.off, id];
    if (options?.noWiden) {
      assertConnectorPolicyNotWidened(editor.getAgentConnectorPolicy(agentId), { off, tools: policy.tools });
    }
    await editor.setAgentConnectorPolicy(agentId, storedConnectorPolicy({ off, tools: policy.tools }));
    return getAgentConnectors(agentId);
  }

  // One tool's permission (the profile's tool list, getAgentConnectorTools):
  // `permission` null drops the tool's entry, so the tool is on its default again.
  async function setAgentConnectorToolPermission(agentId, connectorId, toolName, permission, options) {
    if (permission != null && !CONNECTOR_PERMISSIONS.includes(permission)) {
      throw new Error(`permission must be one of ${CONNECTOR_PERMISSIONS.join(', ')}`);
    }
    const server = requireId(connectorId, 'connector id');
    const tool = requireId(toolName, 'tool name');
    const policy = editablePolicy(agentId);
    // The accounts of one connector (`gmail`, `gmail-2`…) share the permission,
    // stored once under the connector's id; an entry an account kept of its own
    // for this tool goes in the same write.
    const group = connectorGroupId(server);
    const tools = Object.fromEntries(
      Object.entries(policy.tools).map(([id, entries]) => {
        if (id === group || connectorGroupId(id) !== group) return [id, entries];
        const { [tool]: _dropped, ...rest } = entries;
        return [id, rest];
      })
    );
    const own = { ...tools[group] };
    if (permission == null) delete own[tool];
    else own[tool] = permission;
    tools[group] = own;
    if (options?.noWiden) {
      assertConnectorPolicyNotWidened(editor.getAgentConnectorPolicy(agentId), { off: policy.off, tools });
    }
    return editor.setAgentConnectorPolicy(agentId, storedConnectorPolicy({ off: policy.off, tools }));
  }

  // A card's "항상 허용" for a connector tool saves through this same writer.
  setConnectorToolPermissionWriter(setAgentConnectorToolPermission);

  /** `[{ connector, tool }]`: the connector tools this agent may run without
   *  asking (an explicit `auto` entry in its own policy). The profile lists
   *  them so each can be turned back to asking. */
  function getAgentAlwaysAllowedTools(agentId) {
    const tools = editor.getAgentConnectorPolicy(agentId)?.tools || {};
    return Object.entries(tools)
      .flatMap(([connector, own]) =>
        Object.entries(own)
          .filter(([, permission]) => permission === 'auto')
          .map(([tool]) => ({ connector, tool }))
      )
      .sort((a, b) => a.connector.localeCompare(b.connector) || a.tool.localeCompare(b.tool));
  }

  /** `[{ connector, tool, permission, explicit }]`: each installed connector's
   *  tools (the connected server's own, and any the agent's policy names) with
   *  the permission the agent has for the tool itself, so a connector switched
   *  off does not change it, and whether that is an entry of its own policy
   *  rather than the tool's default. The profile's per-tool editor reads it. */
  function getAgentConnectorTools(agentId) {
    const { tools } = editablePolicy(agentId);
    return installedIds().flatMap((connector) => {
      const group = connectorGroupId(connector);
      const accounts = Object.entries(tools).filter(([id]) => connectorGroupId(id) === group);
      const names = new Set([
        ...listConnectorTools(connector).map(({ name }) => name),
        ...accounts.flatMap(([, entries]) => Object.keys(entries)),
      ]);
      // Accounts share one permission (stored under the connector); entries an
      // account kept of its own follow the topmost.
      return [...names].map((tool) => ({
        connector,
        tool,
        permission: connectorToolPermission(
          { off: [], tools },
          { mcpServerName: connector, mcpToolName: tool }
        ),
        explicit: connectorToolEntries(tools, group, tool).length > 0,
      }));
    });
  }

  /** Replace the agent's connector policy (null removes it). With `options.noWiden`
   *  the replacement may not give any tool more authority than the stored policy. */
  async function setAgentConnectors(agentId, connectors, options) {
    if (options?.noWiden) {
      const next = connectors == null ? null : parseConnectorPolicy(connectors);
      assertConnectorPolicyNotWidened(editor.getAgentConnectorPolicy(agentId), next);
    }
    return editor.setAgentConnectorPolicy(agentId, connectors);
  }

  /** The registered Project at `projectPath` (its path is the policy key). */
  function registeredProject(projectPath) {
    const path = requireId(projectPath, 'project path');
    const project = listProjects().find((entry) => samePath(entry.path, path));
    if (!project) throw new Error(`project not registered: ${path}`);
    return project.path;
  }

  function projectPolicies() {
    const policies = readProjectConnectorsFile(projectFile());
    if (policies === DENY_ALL_CONNECTORS) return policies;
    return policies || [];
  }

  /** `[{ id, enabled }]`: each installed connector and whether the project allows it. */
  function getProjectConnectors(projectPath) {
    const root = registeredProject(projectPath);
    const policies = projectPolicies();
    if (policies === DENY_ALL_CONNECTORS) return switches(DENY_ALL_CONNECTORS);
    const off = policies.filter((entry) => samePath(entry.root, root)).flatMap((entry) => entry.off);
    return switches({ off, tools: {} });
  }

  /** Rewrite the project policy file under its lock; `edit` maps root → off list. */
  function updateProjectPolicies(edit) {
    const path = projectFile();
    withFileLockSync(`${path}.lock`, () => {
      const policies = projectPolicies();
      // A file that cannot be read is never overwritten: it may hold switches.
      if (policies === DENY_ALL_CONNECTORS) {
        throw new Error(`${PROJECT_CONNECTORS_FILE} cannot be read; fix or remove it first`);
      }
      const byRoot = new Map(policies.map(({ root, off }) => [root, off]));
      edit(byRoot);
      const projects = {};
      for (const [root, off] of byRoot) if (off.length) projects[root] = { off: [...new Set(off)].sort() };
      writeJsonAtomicSync(path, { projects }, { lock: false });
    });
  }

  /** Switch one connector on or off for the project; returns its switches. */
  function setProjectConnectorEnabled(projectPath, connectorId, enabled, options) {
    const id = requireId(connectorId, 'connector id');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const root = registeredProject(projectPath);
    updateProjectPolicies((byRoot) => {
      const key = [...byRoot.keys()].find((entry) => samePath(entry, root)) ?? root;
      const current = byRoot.get(key) || [];
      // Under the policy file lock, against the file as it is now.
      if (options?.noWiden && enabled && current.includes(id)) throw new Error(NO_WIDEN_MESSAGE);
      const off = current.filter((entry) => entry !== id);
      byRoot.set(key, enabled ? off : [...off, id]);
    });
    return getProjectConnectors(root);
  }

  /** One-time, idempotent: legacy allow lists become deny lists. Agent lists
   *  (agent.json arrays) switch off each configured connector they did not
   *  enable; MCP project scopes (`extensionScopes.mcp`, "only in these
   *  projects") switch the server off in every other registered Project.
   *  Skipped while the configured connector set is not fully known. */
  function migrateConnectorPolicies() {
    const catalog = resolveConfiguredMcpCatalog?.();
    if (!catalog || (catalog.warnings || []).some((warning) => PLUGIN_REGISTRY_WARNING.test(warning?.message || ''))) {
      return { skipped: true, agents: [], scopes: [] };
    }
    const installed = Object.keys(catalog.servers || {});
    const agents = [];
    const agentsDir = join(dataDir(), 'agents');
    let entries = [];
    try {
      entries = readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const file = join(agentsDir, entry.name, 'agent.json');
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // missing or unreadable: the runtime already denies or allows as before
      }
      if (!Array.isArray(manifest?.connectors)) continue;
      const next = storedConnectorPolicy(
        migrateLegacyConnectorPolicy(parseConnectorPolicy(manifest.connectors), installed)
      );
      if (next) manifest.connectors = next;
      else delete manifest.connectors;
      writeJsonAtomicSync(file, manifest, { backup: true });
      agents.push(entry.name);
    }
    const config = getConfig?.();
    const scoped = Object.entries(extensionScopesFromConfig(config).mcp);
    if (scoped.length) {
      const projects = listProjects();
      updateProjectPolicies((byRoot) => {
        for (const [server, roots] of scoped) {
          for (const { path } of projects) {
            if (cwdWithinProjects(path, roots)) continue;
            const key = [...byRoot.keys()].find((root) => samePath(root, path)) ?? path;
            byRoot.set(key, [...(byRoot.get(key) || []), server]);
          }
        }
      });
      let next = config;
      for (const [server] of scoped) next = withExtensionScope(next, 'mcp', server, null);
      saveConfigAndAdopt(next);
    }
    return { skipped: false, agents, scopes: scoped.map(([server]) => server) };
  }

  return {
    listConnectors,
    listConnectorTools,
    getAgentConnectors,
    setAgentConnectors,
    setAgentConnectorEnabled,
    setAgentConnectorToolPermission,
    getAgentAlwaysAllowedTools,
    getAgentConnectorTools,
    getProjectConnectors,
    setProjectConnectorEnabled,
    migrateConnectorPolicies,
  };
}
