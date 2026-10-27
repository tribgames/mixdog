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
// (updateSessionRoute `routeFallbacks`); a fallback hop reads it from the
// owner's route at that moment (route-fallback-chain.mjs).
import { loadConfig } from '../../config.mjs';
import { findPreset } from '../../runtime-core/config-helpers.mjs';
import { normalizeWorkflowRoute } from '../../runtime-core/workflow.mjs';
import { canonicalRouteProvider } from '../../../../shared/model-route-chain.mjs';
import { storedBotRoute } from '../../../../shared/agent-store.mjs';
import { configuredAgentRouteCandidates } from '../../../../shared/agent-route-config.mjs';
import { CODING_MODE } from '../agent-mode.mjs';

/** Whether two routes name the same model (provider aliases folded). */
export const sameRouteModel = (a, b) =>
  Boolean(a?.provider && a?.model) &&
  canonicalRouteProvider(a.provider) === canonicalRouteProvider(b?.provider) &&
  String(a.model) === String(b?.model);

/** The owner's stored route (primary plus `fallbacks`), normalized; null when
 *  the owner has none or it cannot be read. */
export function ownerConfiguredRoute({ sessionMode, agentId, config = null }) {
  if (!agentId) return null;
  const cfg = () => config || loadConfig({ secrets: false });
  let stored;
  if (sessionMode === CODING_MODE) {
    const loaded = cfg();
    stored = findPreset(loaded, loaded?.default);
  } else {
    // Before the bot split a bot's route is still in the config (Mixy's never).
    stored = storedBotRoute(agentId) || (agentId === 'lead' ? null : configuredAgentRouteCandidates(cfg(), agentId)[0]);
  }
  if (!stored) return null;
  try {
    return normalizeWorkflowRoute(stored) || null;
  } catch {
    return null;
  }
}

export function ownerRouteFallbacks({ sessionMode, agentId, provider, model, config = null }) {
  const route = ownerConfiguredRoute({ sessionMode, agentId, config });
  if (!route?.fallbacks?.length) return [];
  return sameRouteModel(route, { provider, model }) ? route.fallbacks : [];
}
