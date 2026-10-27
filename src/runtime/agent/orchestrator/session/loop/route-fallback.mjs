import { routeFallbackVerdict } from '../../../../shared/model-route-fallback.mjs';
import { providerErrorKind } from '../../providers/provider-error-kind.mjs';
import { displayModelName } from '../../../../shared/model-display.mjs';
import { presentErrorText } from '../../../../shared/err-text.mjs';
import { getProvider, initProviders } from '../../providers/registry.mjs';
import { loadConfig } from '../../config.mjs';
import { ensureProviderEnabled } from '../../runtime-core/config-helpers.mjs';
import { updateSessionRoute } from '../manager/session-lifecycle.mjs';
import {
  liveRouteFallbacks,
  nextRouteFallbackIndex,
  routeFallbackHopped,
  routeLeaf,
} from '../manager/route-fallback-chain.mjs';
import { pinSessionWireRoute } from '../../providers/wire-route.mjs';
import { buildRequestSendOptions } from '../manager/ask-turn-loop-options.mjs';
import { prepareTurnEffortConfiguration } from '../../providers/effort-configuration.mjs';
import { resolveSessionContextMeta } from '../manager/context-meta.mjs';
import { stripProviderReplayMessages } from '../manager/provider-replay.mjs';
import { isAgentOwner } from '../../agent-owner.mjs';
import { rebuildToolSurfaceForProviderWithMigration } from './tool-exposure-migration.mjs';

// The short reason a notice gives for leaving a model, by provider kind.
const HOP_REASONS = {
  quota_exhausted: 'usage limit reached',
  entitlement: 'not included in the plan',
  billing: 'out of credits',
  rate_limited: 'rate-limited',
  overloaded: 'unavailable',
  transient: 'unavailable',
  service_tier_unavailable: 'unavailable',
  auth: 'sign-in failed',
  permission: 'access denied',
  invalid_request: 'model not available',
  context_overflow: 'context too long',
};

const routeLabel = (route) => displayModelName(route.model, route.provider) || `${route.provider}/${route.model}`;

/** The muted transcript line for a hop: `<from> <reason> — switched to <to>.` */
export function routeFallbackNoticeText(from, to, error) {
  const reason = HOP_REASONS[providerErrorKind(error).kind] || 'unavailable';
  return `${routeLabel(from)} ${reason} — switched to ${routeLabel(to)}.`;
}

function routeFailure(route, error) {
  return {
    provider: route.provider,
    model: route.model,
    kind: providerErrorKind(error).kind,
    error: presentErrorText(error),
  };
}

// The chain ended after at least one hop: the final error keeps its own kind
// and names every model that was tried and why each failed. `skipped` is the
// next route when the chain stopped before it (a context overflow whose next
// window is no larger), so the text says why instead of "every model failed".
function annotateEndedChain(session, error, skipped = null) {
  const tried = session?.routeFallbackFailures;
  if (!tried?.length || !error || typeof error !== 'object' || error.routeFallbackAttempts) return;
  const attempts = [...tried, routeFailure(session, error)];
  try {
    error.routeFallbackAttempts = attempts;
    const lines = attempts.map((attempt) => `${routeLabel(attempt)}: ${attempt.error}`).join('; ');
    const head = skipped
      ? `Fallback chain stopped before ${routeLabel(skipped)} (its context window is not larger) — tried`
      : 'Every model in the fallback chain failed —';
    error.message = `${error.message}\n${head} ${lines}`;
    if (skipped) error.routeFallbackStoppedBefore = { provider: skipped.provider, model: skipped.model };
  } catch {
    /* frozen errors keep their own message */
  }
}

// A context overflow moves only to a model whose window is larger.
async function nextContextGrows(state, next) {
  await initProviders(ensureProviderEnabled(loadConfig(), next.provider), { signal: state.signal });
  state.throwIfAborted();
  const provider = getProvider(next.provider);
  if (!provider) return false;
  const current = resolveSessionContextMeta(state.provider, state.sessionRef.model, state.sessionRef).rawContextWindow;
  const window = resolveSessionContextMeta(provider, next.model, next).rawContextWindow;
  return Number(window) > Number(current || state.sessionRef.selectedContextWindow || 0);
}

export async function advanceAgentRoute(state, error) {
  const session = state.sessionRef;
  if (!session?.agent) return false;
  // Read from the session's settings at this hop: a chain edited while it runs
  // applies now, and one cleared to [] leaves the provider's own error.
  const { chain } = liveRouteFallbacks(session, loadConfig({ secrets: false }));
  if (!chain.length) return false;
  const index = nextRouteFallbackIndex(session, chain);
  const next = chain[index];
  // Only THIS request must have produced nothing (its stream outcome says so):
  // earlier requests of the turn may have run tools. Their calls and results
  // are already in the live turn, which the next model continues from, so no
  // completed tool runs again.
  const verdict = routeFallbackVerdict(error, { signal: state.signal });
  const hops = verdict === 'hop' || (verdict === 'context' && next && (await nextContextGrows(state, next)));
  if (!next || !hops) {
    if (verdict !== 'stay') annotateEndedChain(session, error, next || null);
    return false;
  }
  state.throwIfAborted();
  await initProviders(ensureProviderEnabled(loadConfig(), next.provider), { signal: state.signal });
  state.throwIfAborted();
  const provider = getProvider(next.provider);
  if (!provider) throw new Error(`Provider "${next.provider}" not available`);
  const failed = routeFailure(session, error);
  // The route a reset returns to (setup reset_route_fallback), kept from the first hop.
  const primary = routeFallbackHopped(session) ? session.routeFallbackPrimary : routeLeaf(session);
  // The left model's share of the turn ends here: the running total at the
  // switch bounds it, so each model's tokens are booked at its own rates.
  state.routeUsageHops = [
    ...(state.routeUsageHops || []),
    { provider: session.provider, model: session.model, usage: state.lastUsage ? { ...state.lastUsage } : null },
  ];
  const notice = routeFallbackNoticeText(session, next, error);
  // Saved with the new route: a crash before the live turn is checkpointed
  // again recovers that turn without the previous provider's native state.
  if (session.activeTurnCheckpoint && typeof session.activeTurnCheckpoint === 'object') {
    session.activeTurnCheckpoint = { ...session.activeTurnCheckpoint, routeChanged: true };
  }
  const oldOptions = buildRequestSendOptions({
    sessionId: state.sessionId,
    session,
    signal: state.signal,
  });
  const updated = updateSessionRoute(
    session.id,
    {
      ...next,
      effort: next.effort || null,
      fast: next.fast === true,
      autoEffort: next.autoEffort !== false,
      modelParameters: next.modelParameters || {},
      contextPercent: next.contextPercent,
      contextTokens: next.contextTokens,
      selectedContextWindow: resolveSessionContextMeta(provider, next.model, next).rawContextWindow,
    },
    // The live turn object is what changes: the route is applied to it in place, never to
    // another copy of the id (a disk reload after a generation takeover).
    { crossProvider: true, session }
  );
  if (!updated) throw new Error('agent session closed during model fallback');
  updated.routeFallbacks = chain;
  if (primary) updated.routeFallbackPrimary = primary;
  updated.routeFallbackIndex = index + 1;
  updated.routeFallbackFailures = [...(session.routeFallbackFailures || []), failed];
  await pinSessionWireRoute(updated, provider);
  state.throwIfAborted();
  // The route change replaced the session's tools with its whole resolved list.
  // A delegated agent's surface was already re-applied by updateSessionRoute
  // (applyAgentToolExposure); a Lead-class session gets its deferred surface
  // restored for the new provider, as a manual model switch does.
  if (!isAgentOwner(updated)) rebuildToolSurfaceForProviderWithMigration(updated, next.provider, state.messages);
  // The live turn (prompt, assistant tool calls, tool results) carries on;
  // only the previous provider's native replay state is dropped from it.
  state.messages.splice(0, state.messages.length, ...stripProviderReplayMessages(state.messages));
  updated.liveTurnMessages = state.messages;
  state.sessionRef = updated;
  state.provider = provider;
  state.model = updated.model;
  state.tools = updated.tools;
  state.providerState = undefined;
  state.providerStateUpdated = true;
  state.prefixGuardState = null;
  state.fixedProviderToolSurface = null;
  state.cacheBreakTraceKeys.clear();
  state.transportRetriesUsed = 0;
  state.transportRetryMax = 0;
  for (const key of Object.keys(oldOptions)) delete state.opts[key];
  Object.assign(
    state.opts,
    buildRequestSendOptions({
      sessionId: state.sessionId,
      session: updated,
      turnEffort: updated.effort,
      effortConfiguration: prepareTurnEffortConfiguration(updated, provider),
      signal: state.signal,
    })
  );
  try {
    process.stderr.write(
      `[route-fallback] ${failed.provider}/${failed.model} (${failed.kind}) -> ${updated.provider}/${updated.model}\n`
    );
    state.opts.onStageChange?.('notice', { tone: 'info', message: notice });
  } catch {
    /* display-only */
  }
  state.opts.onStageChange?.('connecting', {
    provider: updated.provider,
    model: updated.model,
    reason: 'model-fallback',
  });
  return true;
}
