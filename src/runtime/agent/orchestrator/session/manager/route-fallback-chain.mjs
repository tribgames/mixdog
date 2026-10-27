// The fallback chain a running session follows, read from its settings when
// it is needed (a hop, a status read) instead of the copy taken at creation:
// an edit made while the session runs applies from its next model request,
// and a chain cleared to [] stops further hops at once.
// - A Lead-class session (coding Lead, a bot's chat, Mixy) follows its
//   owner's stored route (owner-route-fallbacks.mjs);
// - a delegated agent follows the route it was spawned from
//   (`routeFallbackSource`: its agent's route, else Main's, or a named preset).
// The stored chain applies only while the session's primary — the route it
// ran on before its first hop — is that stored route's model. A session
// whose source cannot be read (an older record, a direct route) keeps its own.
import { findPreset } from '../../runtime-core/config-helpers.mjs';
import { normalizeWorkflowRoute } from '../../runtime-core/workflow.mjs';
import { configuredAgentRouteCandidates } from '../../../../shared/agent-route-config.mjs';
import { CODING_MODE, resolveSessionMode } from '../agent-mode.mjs';
import { _liveSessions } from '../store/live-state.mjs';
import { ownerConfiguredRoute, sameRouteModel } from './owner-route-fallbacks.mjs';

const LEAF_FIELDS = ['effort', 'fast', 'autoEffort', 'modelParameters', 'contextPercent', 'contextTokens'];

/** The switchable fields of a route or session record (no chain). */
export function routeLeaf(route) {
  const leaf = { provider: route?.provider || '', model: route?.model || '' };
  for (const key of LEAF_FIELDS) if (route?.[key] !== undefined && route[key] !== null) leaf[key] = route[key];
  return leaf;
}

/** The route the session ran on before its first fallback hop; its own route
 *  while it has not hopped. */
export function sessionRoutePrimary(session) {
  if (session?.routeFallbackPrimary?.provider) return session.routeFallbackPrimary;
  const first = session?.routeFallbackFailures?.[0];
  if (first?.provider && first?.model) return { provider: first.provider, model: first.model };
  return routeLeaf(session);
}

function normalizedOrNull(stored) {
  if (!stored) return null;
  try {
    return normalizeWorkflowRoute(stored) || null;
  } catch {
    return null;
  }
}

/** The stored route the session's chain comes from, read now; null when the
 *  session has no readable source (it then keeps its own chain). */
export function sessionChainSource(session, config) {
  const { mode, agentId } = resolveSessionMode({ session });
  if (agentId) return ownerConfiguredRoute({ sessionMode: mode, agentId, config });
  const source = session?.routeFallbackSource;
  if (source?.agent) {
    // As the spawn resolved it: the agent's own route, else Main's.
    const own = configuredAgentRouteCandidates(config, source.agent).map(normalizedOrNull).find(Boolean);
    return own || normalizedOrNull(findPreset(config, config?.default));
  }
  if (source?.preset) return normalizedOrNull(findPreset(config, source.preset));
  return null;
}

/** `{ chain, fromSettings }`: the fallback routes the session follows now. */
export function liveRouteFallbacks(session, config) {
  const source = sessionChainSource(session, config);
  if (!source)
    return { chain: Array.isArray(session?.routeFallbacks) ? session.routeFallbacks : [], fromSettings: false };
  const onSourcePrimary = sameRouteModel(source, sessionRoutePrimary(session));
  return { chain: onSourcePrimary ? source.fallbacks || [] : [], fromSettings: true };
}

/** Index in `chain` of the next route to try: the first after the session's
 *  current model that this session has not already run (its primary and the
 *  models it already left); `chain.length` when none is left. */
export function nextRouteFallbackIndex(session, chain) {
  const tried = [sessionRoutePrimary(session), ...(session?.routeFallbackFailures || []), session];
  const at = chain.findIndex((entry) => sameRouteModel(entry, session));
  for (let index = at + 1; index < chain.length; index += 1) {
    if (!tried.some((route) => sameRouteModel(chain[index], route))) return index;
  }
  return chain.length;
}

const modelOf = (route) => ({ provider: route?.provider || '', model: route?.model || '' });

/** The public fallback position of one session: the route it is on against
 *  its primary, the hop index, the chain it follows now and why it left each model. */
export function routeFallbackPosition(session, config) {
  const { chain, fromSettings } = liveRouteFallbacks(session, config);
  const next = chain[nextRouteFallbackIndex(session, chain)] || null;
  const primary = sessionRoutePrimary(session);
  const { mode, agentId } = resolveSessionMode({ session });
  let kind = 'agent';
  if (agentId) kind = mode === CODING_MODE ? 'lead' : 'bot';
  return {
    sessionId: session.id,
    kind,
    agent: agentId || session.agent || null,
    current: modelOf(session),
    primary: modelOf(primary),
    onPrimary: sameRouteModel(primary, session),
    fallbackIndex: Number(session.routeFallbackIndex) || 0,
    fallbacks: chain.map(modelOf),
    chainFrom: fromSettings ? 'settings' : 'session',
    next: next ? modelOf(next) : null,
    failures: (session.routeFallbackFailures || []).map(({ provider, model, kind: errorKind, error }) => ({
      provider,
      model,
      kind: errorKind,
      error,
    })),
  };
}

/** Whether the session has left its primary for a fallback model. */
export const routeFallbackHopped = (session) =>
  Number(session?.routeFallbackIndex) > 0 || Boolean(session?.routeFallbackFailures?.length);

/** Positions of the sessions held in this process that follow a chain or have
 *  hopped; `keep(position)` narrows them. */
export function liveRouteFallbackPositions(config, keep = () => true) {
  const rows = [];
  for (const session of _liveSessions.values()) {
    // Only a session with an agent hops (advanceAgentRoute).
    if (!session?.id || session.closed === true || !session.agent) continue;
    const position = routeFallbackPosition(session, config);
    if (!position.fallbacks.length && !routeFallbackHopped(session)) continue;
    if (keep(position)) rows.push(position);
  }
  return rows;
}
