import { clean } from '../session-text.mjs';
import { normalizeAgentId, normalizeWorkflowId, normalizeWorkflowRoute } from '../workflow.mjs';

export function resolveDataDir({ cfgMod, STANDALONE_DATA_DIR }) {
  return cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
}

// Frontmatter values are single-line by format; collapse any newlines.
export function oneLine(value) {
  return clean(value).replace(/\s+/g, ' ');
}

// Custom agents keep their workflow-style id; fixed roles use the agent id.
export function agentEditorId(agentId) {
  return normalizeAgentId(agentId) || normalizeWorkflowId(agentId);
}

// Agents have two states only (a model, or off), so an agent that has never
// been pinned reports the effective Main route instead of an empty one — the
// surfaces must never offer a third "follows Main" state.
export function effectiveAgentRoute({ agentRouteFromConfig, resolveRoute }, config, agentId) {
  return agentRouteFromConfig(config, agentId) || normalizeWorkflowRoute(resolveRoute(config, {}));
}
