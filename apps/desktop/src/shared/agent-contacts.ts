// Which agents are contacts in the Agents pane: the host resolves home threads
// for exactly these, and every surface lists exactly these.
import { MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { isContactAgentId } from '../../../../src/runtime/shared/agent-route-config.mjs';

export { MIXY_AGENT_ID };

/** What Mixy is called until the user names it (same default the renderer shows). */
export const MIXY_DEFAULT_NAME = 'Mixy';

/** One `listAgents` row as the contact rule reads it. */
export interface AgentCatalogRow {
  id?: unknown;
  custom?: unknown;
  disabled?: unknown;
  label?: unknown;
  description?: unknown;
  route?: unknown;
  definition?: unknown;
  /** The agent's `agent.json` avatar pick, if any. */
  avatar?: unknown;
  /** AGENT.md frontmatter `kind`: `agent` marks a Workflows-page agent. */
  kind?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A catalog row's display name: its definition's name, else its label, else its id. */
export function agentRowName(row: AgentCatalogRow): string {
  const definition = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return text((definition as { name?: unknown }).name) || text(row.label) || text(row.id);
}

/** Whether a catalog row is a contact (봇), by the runtime's one rule. */
export function isContactAgentRow(row: AgentCatalogRow): boolean {
  return isContactAgentId(row.id, row.kind);
}

/** The user-facing agents (봇): user-made definitions the user has not
 *  switched off. Shipped roles — the starter sub-agents and the Maintainer —
 *  and agents made on the Workflows page (`kind: agent`) are never contacts,
 *  by the runtime's own rule (isContactAgentId); hidden roles never list.
 *  `includeDisabled` also returns the switched-off ones (the 봇 page lists
 *  every bot; everything else that acts through a bot keeps the default). */
export function contactAgentRows(
  agents: unknown,
  { includeDisabled = false }: { includeDisabled?: boolean } = {}
): Array<AgentCatalogRow & { id: string }> {
  if (!Array.isArray(agents)) return [];
  return agents.filter((row): row is AgentCatalogRow & { id: string } => {
    if (!row || typeof row !== 'object') return false;
    const { custom, disabled } = row as AgentCatalogRow;
    return custom === true && (includeDisabled || disabled !== true) && isContactAgentRow(row as AgentCatalogRow);
  });
}
