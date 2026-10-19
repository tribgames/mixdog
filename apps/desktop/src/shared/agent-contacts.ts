// Which agents are contacts in the Agents pane: the host resolves home threads
// for exactly these, and every surface lists exactly these.
import { MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';

export { MIXY_AGENT_ID };

/** One `listAgents` row as the contact rule reads it. */
export interface AgentCatalogRow {
  id?: unknown;
  custom?: unknown;
  disabled?: unknown;
  label?: unknown;
  description?: unknown;
  route?: unknown;
  definition?: unknown;
}

/** The user-facing agents: custom definitions the user has not switched off.
 *  Fixed slots (memory upkeep) are system roles; hidden roles never list. */
export function contactAgentRows(agents: unknown): Array<AgentCatalogRow & { id: string }> {
  if (!Array.isArray(agents)) return [];
  return agents.filter((row): row is AgentCatalogRow & { id: string } => {
    if (!row || typeof row !== 'object') return false;
    const { id, custom, disabled } = row as AgentCatalogRow;
    return custom === true && disabled !== true && typeof id === 'string' && Boolean(id) && id !== MIXY_AGENT_ID;
  });
}
