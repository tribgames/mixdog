/**
 * routes-agent-definitions.mjs — the session route surface's passthroughs to
 * the runtime's agent, workflow-pack, connector and lead-identity services.
 */
export function createAgentDefinitionApi(runtime) {
  return {
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    // Workflow pack editing (desktop Workflows page): direct passthroughs —
    // the runtime owns validation, user-pack persistence, and delete guards.
    getWorkflowPack: (workflowId) => runtime.getWorkflowPack?.(workflowId) ?? null,
    saveWorkflowPack: async (payload) => runtime.saveWorkflowPack?.(payload) ?? null,
    createWorkflow: async (payload) => runtime.createWorkflow?.(payload) ?? null,
    deleteWorkflow: async (workflowId) => runtime.deleteWorkflow?.(workflowId) ?? null,
    getAgentDefinition: (agentId) => runtime.getAgentDefinition?.(agentId) ?? null,
    getAgentAvatarImage: (agentId) => runtime.getAgentAvatarImage?.(agentId) ?? null,
    getAgentConnectors: (agentId) => runtime.getAgentConnectors?.(agentId) ?? [],
    listConnectors: () => runtime.listConnectors?.() ?? [],
    listConnectorTools: (connectorId) => runtime.listConnectorTools?.(connectorId) ?? [],
    // `options.noWiden` is only ever added by the desktop's remote method table: the
    // change is refused if it would give the agent more authority (checked atomically with the write).
    setAgentConnectors: async (agentId, connectors, options) =>
      runtime.setAgentConnectors?.(agentId, connectors, options) ?? null,
    setAgentConnectorEnabled: async (agentId, connectorId, enabled, options) =>
      runtime.setAgentConnectorEnabled?.(agentId, connectorId, enabled, options) ?? [],
    getProjectConnectors: (projectPath) => runtime.getProjectConnectors?.(projectPath) ?? [],
    setProjectConnectorEnabled: async (projectPath, connectorId, enabled, options) =>
      runtime.setProjectConnectorEnabled?.(projectPath, connectorId, enabled, options) ?? [],
    setAgentConnectorToolPermission: async (agentId, connectorId, toolName, permission, options) =>
      runtime.setAgentConnectorToolPermission?.(agentId, connectorId, toolName, permission, options) ?? null,
    getAgentAlwaysAllowedTools: (agentId) => runtime.getAgentAlwaysAllowedTools?.(agentId) ?? [],
    // Per-agent action-kind permissions (ask / allow / block) for the profile.
    getAgentPermissions: async (agentId) =>
      (await import('../../../runtime/agent/orchestrator/session/human-gate/store.mjs')).agentPermissions(agentId),
    setAgentPermission: async (agentId, action, mode, options) =>
      (await import('../../../runtime/agent/orchestrator/session/human-gate/store.mjs')).setAgentPermission(
        agentId,
        action,
        mode,
        options
      ),
    recordAgentApprovalAudit: async (agentId, action, decision) =>
      (await import('../../../runtime/agent/orchestrator/session/human-gate/store.mjs')).recordAgentApprovalAudit(
        agentId,
        action,
        decision
      ),
    getLeadPersona: () => runtime.getLeadPersona?.() ?? '',
    saveLeadPersona: async (text) => runtime.saveLeadPersona?.(text) ?? '',
    getLeadAgentBody: () => runtime.getLeadAgentBody?.() ?? '',
    saveLeadAgentBody: async (text) => runtime.saveLeadAgentBody?.(text) ?? '',
    getLeadStatus: () =>
      runtime.getLeadStatus?.() ?? { created: null, name: '', avatar: null, homeChatted: false, route: null },
    getLeadHomeRoute: () => runtime.getLeadHomeRoute?.() ?? null,
    saveLeadIdentity: async (payload) => runtime.saveLeadIdentity?.(payload) ?? null,
    setLeadCreated: async (created, description) => runtime.setLeadCreated?.(created, description) ?? null,
    saveAgentDefinition: async (payload, options) => runtime.saveAgentDefinition?.(payload, options) ?? null,
    deleteAgentDefinition: async (agentId) => runtime.deleteAgentDefinition?.(agentId) ?? null,
    agentDefinitionPresence: (agentIds) => runtime.agentDefinitionPresence?.(agentIds) ?? null,
    restoreAgentDefinition: async (agentId) => runtime.restoreAgentDefinition?.(agentId) ?? null,
    purgeAgentDefinition: async (agentId) => runtime.purgeAgentDefinition?.(agentId) ?? null,
    archivedAgentIdentities: (agentIds) => runtime.archivedAgentIdentities?.(agentIds) ?? null,
    // Group-room rows posted by the desktop host into a room's log session.
    appendRoomRows: async (sessionId, rows) =>
      (await import('../../../session-runtime/agent-room-delivery.mjs')).appendRoomRows(sessionId, rows),
    // One group-room supervisor step on the Maintainer route.
    decideRoomTurn: async (input) =>
      (await import('../../../runtime/agent/orchestrator/agent-runtime/room-supervisor-completion.mjs')).decideRoomTurn(
        input
      ),
  };
}
