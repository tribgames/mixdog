// The fallback models a Lead-class session starts with. Agents get theirs from
// their spawn preset (agent-child.mjs); a Lead-class session gets its OWNER's:
// - a coding Lead (new task, task a bot created): the Lead route, i.e. the
//   preset of `config.default` (workflow-lead);
// - an agent-mode Lead (a bot's home chat, a room turn, a routine run, or
//   Mixy's own thread): that bot's own route in its folder (agent.json), so
//   Mixy and the Lead keep separate chains.
// The chain applies only while the session runs on the owner's configured
// primary model. A session the user put on another model (composer picker,
// New Task) is a deliberate choice and gets none. Route changes recompute it
// (updateSessionRoute `routeFallbacks`); a fallback hop does not.
import { loadConfig } from '../../config.mjs';
import { findPreset } from '../../runtime-core/config-helpers.mjs';
import { normalizeWorkflowRoute } from '../../runtime-core/workflow.mjs';
import { canonicalRouteProvider } from '../../../../shared/model-route-chain.mjs';
import { storedBotRoute } from '../../../../shared/agent-store.mjs';
import { configuredAgentRouteCandidates } from '../../../../shared/agent-route-config.mjs';
import { CODING_MODE } from '../agent-mode.mjs';

export function ownerRouteFallbacks({ sessionMode, agentId, provider, model, config = null }) {
  if (!agentId) return [];
  const cfg = () => config || loadConfig({ secrets: false });
  let stored;
  if (sessionMode === CODING_MODE) {
    stored = findPreset(cfg(), cfg()?.default);
  } else {
    // Before the bot split a bot's route is still in the config (Mixy's never).
    stored = storedBotRoute(agentId) || (agentId === 'lead' ? null : configuredAgentRouteCandidates(cfg(), agentId)[0]);
  }
  if (!stored?.fallbacks?.length) return [];
  let route;
  try {
    route = normalizeWorkflowRoute(stored);
  } catch {
    return [];
  }
  const onPrimary =
    route &&
    canonicalRouteProvider(route.provider) === canonicalRouteProvider(provider) &&
    String(route.model) === String(model);
  return onPrimary ? route.fallbacks || [] : [];
}
