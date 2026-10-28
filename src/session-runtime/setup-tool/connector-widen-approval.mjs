/** A bot's request for more authority on one connector tool (setup
 *  set_agent_connector_tool toward auto or needs_approval): the model cannot
 *  tell the user's words from text it read, so the change waits on an
 *  approval card (human-gate/requests.mjs kind `connector`) that only a
 *  person answers. The card offers each level above the tool's current one
 *  (needs_approval, auto) and Deny; nothing is remembered, so every widening
 *  asks again. The picked level is applied to that one tool, re-judged on the
 *  stored policy inside its write (mcp/agent-connectors.mjs
 *  withApprovedConnectorToolChange): a restriction that landed meanwhile stays. */
import {
  CONNECTOR_TOOL_ALREADY,
  CONNECTOR_TOOL_NARROWED,
  NO_WIDEN_MESSAGE,
  PERMISSION_RANK,
  agentConnectors,
  connectorGroupId,
  connectorToolPermission,
  withApprovedConnectorToolChange,
} from '../../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import { recordHumanDecision } from '../../runtime/agent/orchestrator/session/human-gate/gate.mjs';
import { CONNECTOR_WIDEN_LEVELS } from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import { runAbortable } from '../../runtime/shared/abort-race.mjs';

const NO_WIDEN = Object.freeze({ noWiden: true });

/** The tool's effective level for `agent` now, as dispatch reads it. */
function currentLevel(agent, server, tool) {
  return connectorToolPermission(agentConnectors(agent), {
    name: `mcp__${server}__${tool}`,
    mcpServerName: server,
    mcpToolName: tool,
  });
}

/** Ask the person on a card, then apply the level they picked.
 *  `requestApproval` is the calling turn's approval hook. */
export async function askToWidenConnectorTool(
  rt,
  { agent, server, tool, requested },
  { requestApproval, signal, sessionId, toolCallId } = {}
) {
  const from = currentLevel(agent, server, tool);
  const receipt = { agent, connector: server, tool, requested };
  if (PERMISSION_RANK[from] >= PERMISSION_RANK[requested]) {
    return { ...receipt, saved: false, permission: from, note: `The tool is already ${from}; nothing changed.` };
  }
  // Nobody can be shown a card here: the person makes it in the desktop app.
  if (typeof requestApproval !== 'function') throw new Error(NO_WIDEN_MESSAGE);
  const choices = CONNECTOR_WIDEN_LEVELS.filter((level) => PERMISSION_RANK[level] > PERMISSION_RANK[from]);
  const answer = await runAbortable(signal, () =>
    requestApproval({
      name: 'setup',
      kind: 'connector',
      agentId: agent,
      // The card names the connector, not one of its accounts.
      connector: { server: connectorGroupId(server), tool, from, requested, choices },
      args: { action: 'set_agent_connector_tool', agent, name: server, tool, permission: requested },
      reason: `Bot "${agent}" asks to change the permission of ${tool} (${connectorGroupId(server)}) from ${from} to ${requested}.`,
      remember: ['once'],
      sessionId,
      toolCallId,
    })
  );
  const level = answer?.approved === true && choices.includes(answer.scope) ? answer.scope : '';
  // Audited with the answering device; no grant is ever stored (no action kind).
  await recordHumanDecision(
    { agentId: agent, kind: 'connector', tool: `${server}/${tool}`, target: `${from}>${level || requested}` },
    answer
  );
  // A decision that settles after its turn was cancelled authorizes nothing.
  signal?.throwIfAborted();
  if (!level) {
    const why = answer?.timedOut ? 'The approval card timed out' : 'The user did not approve this change';
    return { ...receipt, saved: false, approved: false, permission: from, note: `${why}; nothing changed.` };
  }
  try {
    await withApprovedConnectorToolChange({ server, tool, from, to: level }, () =>
      rt.setAgentConnectorToolPermission(agent, server, tool, level, NO_WIDEN)
    );
  } catch (error) {
    if (error?.code !== CONNECTOR_TOOL_NARROWED && error?.code !== CONNECTOR_TOOL_ALREADY) throw error;
    return {
      ...receipt,
      saved: false,
      approved: true,
      permission: currentLevel(agent, server, tool),
      note: `The user approved ${level}, but it was not applied: ${error.message}`,
    };
  }
  return {
    ...receipt,
    approved: true,
    permission: level,
    note: `The user approved on the card; ${tool} is now ${level}.`,
  };
}