/** Setup actions for per-agent and per-project switches and the bot roster:
 *  action permissions, connector switches, archived bots, bot order and
 *  prompt-cache warming. Each goes through the runtime method its settings
 *  surface uses. Permission and connector writes are made as a remote client's
 *  are (`noWiden`): a chat may take authority away, never give an agent more
 *  without asking — that stays with the person in the desktop app. */
import { agentPermissions, setAgentPermission } from '../../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

const NO_WIDEN = Object.freeze({ noWiden: true });

function requireText(value, label) {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export const AGENT_SETTINGS_HANDLERS = {
  async read_agent_settings(rt, args) {
    const agent = requireText(args.agent, 'agent');
    const [permissions, connectors, alwaysAllowedTools] = await Promise.all([
      agentPermissions(agent),
      rt.getAgentConnectors(agent),
      rt.getAgentAlwaysAllowedTools(agent),
    ]);
    return { agent, permissions, connectors, alwaysAllowedTools };
  },
  read_project_connectors: async (rt, args) => {
    const projectPath = requireText(args.projectPath, 'projectPath');
    return { projectPath, connectors: await rt.getProjectConnectors(projectPath) };
  },
  async set_agent_permission(_rt, args) {
    const agent = requireText(args.agent, 'agent');
    return { agent, permissions: await setAgentPermission(agent, args.actionKind, args.permissionMode, NO_WIDEN) };
  },
  async set_agent_connector(rt, args) {
    const agent = requireText(args.agent, 'agent');
    const name = requireText(args.name, 'name');
    return { agent, connectors: await rt.setAgentConnectorEnabled(agent, name, args.enabled, NO_WIDEN) };
  },
  async set_agent_connector_tool(rt, args) {
    const agent = requireText(args.agent, 'agent');
    const name = requireText(args.name, 'name');
    const tool = requireText(args.tool, 'tool');
    await rt.setAgentConnectorToolPermission(agent, name, tool, args.permission, NO_WIDEN);
    return { agent, connector: name, tool, permission: args.permission };
  },
  async set_project_connector(rt, args) {
    const projectPath = requireText(args.projectPath, 'projectPath');
    const name = requireText(args.name, 'name');
    return { projectPath, connectors: await rt.setProjectConnectorEnabled(projectPath, name, args.enabled, NO_WIDEN) };
  },
  async restore_definition(rt, args) {
    if (args.definitionKind !== 'agent') {
      throw new Error('Only an archived agent or bot can be restored; a deleted workflow is gone');
    }
    const name = requireText(args.name, 'name');
    await rt.restoreAgentDefinition(name);
    return { restored: name, note: 'Its chat is back; its routines stay off until they are turned on.' };
  },
  set_bot_order: (rt, args) => ({ botOrder: rt.setBotOrder(args.botOrder).order }),
  set_cache_warming_enabled: (rt, args) => ({
    promptCacheWarming: rt.setCacheWarmingEnabled(args.enabled).enabled,
  }),
};
