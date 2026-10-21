/**
 * set-route.mjs — select the runtime's route: resolve and validate the
 * request, adopt it as the live route (its per-model settings saved; the main
 * model only on an explicit main-model choice, keepMainModel: false), then
 * decide when the current session follows it
 * (untouched, tuned, recreated, updated in place when empty, or switched in
 * place when the selection is addressed to an established conversation).
 */
import { clean, hasOwn } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  ensureProviderEnabled,
  findPreset,
  modelMetaLooksResolved,
  validateRequestedModelSelector,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { getModelMetadataSync } from '../../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { workflowPresetId } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { resolveRouteContextState, selectionFastCapable } from '../route-state.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import {
  sessionHasRouteHistory,
  sessionRouteCommitted,
  shouldRecreateEmptySessionForRouteChange,
} from '../../runtime/agent/orchestrator/runtime-core/session-route-policy.mjs';
import { rebuildToolSurfaceForProviderWithMigration } from '../../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs';
import { UNOWNED_LEASE, openRouteLease } from './route-ownership.mjs';
import { resolveSessionMode } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { ownerRouteFallbacks } from '../../runtime/agent/orchestrator/session/manager/owner-route-fallbacks.mjs';
import { normalizeWorkflowRoute } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { routeChain, validateRouteChainProviders } from '../../runtime/shared/model-route-chain.mjs';
import { resolveChainEntry } from '../workflow-agents-api/agent-route.mjs';

/** The request, completed from the live route where the caller left gaps. */
function completeRequest(deps, next) {
  const { getConfig, getRoute } = deps;
  const requested = { ...(next || {}) };
  validateRequestedModelSelector(getConfig(), requested);
  if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(getRoute(), 'effort')) {
    requested.effort = getRoute().effort;
  }
  if (!requested.provider && requested.model && !findPreset(getConfig(), requested.model)) {
    requested.provider = getRoute().provider;
  }
  return requested;
}

async function resolveSelectedRoute(deps, next) {
  const { getConfig, resolveRoute, ensureProvidersReady, lookupModelMeta } = deps;
  const providerExplicitlyRequested = clean(next?.provider) !== '';
  const selectedRoute = resolveRoute(getConfig(), completeRequest(deps, next));
  await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
  const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
  if (
    !providerExplicitlyRequested &&
    !selectedRoute.preset &&
    !modelMetaLooksResolved(modelMeta) &&
    !getModelMetadataSync(selectedRoute.model, selectedRoute.provider)
  ) {
    throw new Error(`unknown model: ${selectedRoute.provider}/${selectedRoute.model}`);
  }
  const fastCapable = selectionFastCapable(
    selectedRoute.provider,
    modelMeta,
    selectedRoute.effort,
    selectedRoute.modelParameters
  );
  const contextState = resolveRouteContextState(selectedRoute, modelMeta);
  // An exact selection is saved clamped, and not at all when it is the
  // default window; an unknown window keeps it as requested.
  const contextTokens =
    contextState.contextDefaultPercent === undefined ? selectedRoute.contextTokens : contextState.contextTokens;
  const { contextTokens: requestedTokens, ...routeFields } = selectedRoute;
  // Tokens that land on the default window select the default, whatever
  // percent travelled with them.
  const tokensAtDefault = requestedTokens && !contextTokens && contextState.contextDefaultPercent !== undefined;
  return {
    selectedRoute: {
      ...routeFields,
      ...(tokensAtDefault ? { contextPercent: contextState.contextDefaultPercent } : {}),
      fast: fastCapable ? selectedRoute.fast === true : false,
      // Lets the saved model settings tell a chosen window from the default.
      contextDefaultPercent: contextState.contextDefaultPercent,
      ...(contextTokens ? { contextTokens } : {}),
    },
    fastCapable,
    modelMeta,
  };
}

/** Close the empty session and materialize a fresh one for the new provider. */
async function recreateEmptySession(deps, lease) {
  const { getSession, setSession, mgr, statusRoutes, createCurrentSession, invalidatePreSessionToolSurface } = deps;
  // If the boot create is still finishing SessionStart/deferred-surface
  // work, drain that promise first. Otherwise createCurrentSession()
  // would return the old in-flight promise after we tombstone/null the
  // session, racing the intended rebuild for the new provider.
  await createCurrentSession('model-switch-empty-drain');
  const closed = lease.run(
    () => {
      const emptySession = getSession();
      if (!emptySession?.id || sessionHasRouteHistory(emptySession)) return false;
      statusRoutes?.clearGatewaySessionRoute?.(emptySession.id);
      mgr.closeSession?.(emptySession.id, 'cli-model-switch-empty', { tombstone: true });
      setSession(null);
      invalidatePreSessionToolSurface?.();
      return true;
    },
    () => false
  );
  if (closed) await createCurrentSession('model-switch-empty');
}

/** The fallback chain a Lead-class session follows on `route`: its owner's chain
 *  while the route is the owner's primary model, none otherwise (see
 *  owner-route-fallbacks.mjs). Nothing for an agent's session, which keeps its own. */
export function sessionRouteFallbackFields(deps, session, route) {
  const { mode, agentId } = resolveSessionMode({ session });
  if (!agentId) return {};
  return {
    routeFallbacks: ownerRouteFallbacks({
      sessionMode: mode,
      agentId,
      provider: route.provider,
      model: route.model,
      config: deps.getConfig(),
    }),
  };
}

/** A same-model selection (a bot profile saved with new fallbacks) restarts the
 *  addressed session's chain when the owner's chain no longer matches it. */
function refreshSessionFallbacks(deps, session) {
  const fields = sessionRouteFallbackFields(deps, session, deps.getRoute());
  if (!fields.routeFallbacks) return;
  if (JSON.stringify(fields.routeFallbacks) === JSON.stringify(session.routeFallbacks || [])) return;
  deps.mgr.updateSessionRoute?.(session.id, fields, { session });
}

/** Rewrite the addressed empty session to the route it was asked to run on. */
function updateSessionInPlace(deps, session, updateOptions) {
  const { getRoute, getSession, setSession, mgr, statusRoutes } = deps;
  const route = getRoute();
  const fields = {
    provider: route.provider,
    model: route.model,
    fast: route.fast === true,
    autoEffort: route.autoEffort !== false,
    effort: route.effectiveEffort || null,
    modelParameters: route.modelParameters || {},
    contextPercent: route.contextPercent,
    contextTokens: route.contextTokens || null,
    selectedContextWindow: route.selectedContextWindow || null,
    ...sessionRouteFallbackFields(deps, session, route),
  };
  const updated = mgr.updateSessionRoute?.(session.id, fields, updateOptions);
  if (updated) setSession(updated);
  else Object.assign(session, fields);
  rebuildToolSurfaceForProviderWithMigration(getSession(), route.provider);
  writeStatuslineRoute(statusRoutes, getSession(), route);
}

/** Index of the message a model switch boundary is recorded on: the last one
 *  before a trailing unanswered prompt, which a retry may rewind. */
function modelSwitchAnchorIndex(messages) {
  let index = messages.length - 1;
  while (index >= 0 && (messages[index]?.role === 'user' || messages[index]?.role === 'system')) index -= 1;
  if (index >= 0) return index;
  return messages.findLastIndex((message) => message?.role !== 'system');
}

/** Display-only boundary of an in-place model switch, kept in message meta
 *  (like an inheritance boundary): the transcript shows it live and after a
 *  restore, and the model conversation gains no synthetic message. */
export function recordModelSwitchBoundary(session, boundary) {
  return recordTranscriptBoundary(
    session,
    'modelSwitches',
    boundary,
    (entry) => entry?.at === boundary.at && entry?.modelId === boundary.modelId
  );
}

/** A display-only boundary appended to `meta[field]` of the switch anchor
 *  message (model and workflow switches); `same` finds an already recorded one. */
export function recordTranscriptBoundary(session, field, boundary, same) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const index = modelSwitchAnchorIndex(messages);
  if (index < 0) return false;
  const anchor = messages[index];
  const switches = Array.isArray(anchor.meta?.[field]) ? anchor.meta[field] : [];
  if (switches.some(same)) return true;
  // Replace the message object: the session save worker detects changed
  // messages by reference identity, so an in-place meta edit is never saved.
  messages[index] = { ...anchor, meta: { ...anchor.meta, [field]: [...switches, boundary] } };
  return true;
}

/** Move the addressed, established session onto the adopted route in place.
 *  Its provider replay state and context readings are dropped, so the next
 *  turn re-measures and auto-compacts against the new model's window. Returns
 *  the recorded boundary, or null when the session has nothing to mark. */
function switchSessionInPlace(deps, session) {
  const { getRoute, getSession } = deps;
  const route = getRoute();
  if (route.provider === session.provider && route.model === session.model) {
    updateSessionInPlace(deps, session);
    return null;
  }
  const boundary = { provider: route.provider, modelId: route.model, at: Date.now() };
  const recorded = recordModelSwitchBoundary(session, boundary);
  updateSessionInPlace(deps, session, { crossProvider: true });
  // A manager that answered with another copy of the session carries the
  // boundary too; the next save persists it.
  if (recorded && getSession() && getSession() !== session) recordModelSwitchBoundary(getSession(), boundary);
  return recorded ? boundary : null;
}

/** The Lead's fallback models after this selection, checked like an agent's
 *  chain (leaf routes, distinct providers): an explicit list replaces the
 *  stored one ([] clears it), a selection without one keeps it. */
async function leadFallbackChain(deps, next, primary) {
  const storedPreset = findPreset(deps.getConfig(), workflowPresetId('lead'));
  const requested = hasOwn(next || {}, 'fallbacks') ? next.fallbacks : storedPreset?.fallbacks;
  if (!Array.isArray(requested) || !requested.length) return [];
  const chain = routeChain({ provider: primary.provider, model: primary.model, fallbacks: requested });
  validateRouteChainProviders(chain);
  const storedChain = routeChain(storedPreset || {});
  // Each entry goes through the agents' normalizer (fast clamp, context window).
  const resolved = [];
  for (const entry of chain.slice(1)) {
    const previous = storedChain.find((c) => c.provider === entry.provider && c.model === entry.model);
    resolved.push(await resolveChainEntry(deps, entry, previous || {}));
  }
  return (
    normalizeWorkflowRoute({ provider: primary.provider, model: primary.model, fallbacks: resolved })?.fallbacks || []
  );
}

/** Validate, persist and adopt the requested route as the runtime's route. */
async function adoptRoute(deps, persist, next, options, lease) {
  const {
    getConfig,
    getRoute,
    setRouteState,
    resolveRoute,
    refreshRouteEffort,
    refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh,
  } = deps;
  const { selectedRoute, fastCapable, modelMeta } = await resolveSelectedRoute(deps, next);
  // The Lead's fallback chain travels with an explicit main-model choice only
  // (the Lead editor, the setup tool); a session's own pick never touches it.
  const persistedRoute =
    options?.keepMainModel === false && options?.sessionOnly !== true
      ? { ...selectedRoute, fallbacks: await leadFallbackChain(deps, next, selectedRoute) }
      : selectedRoute;
  // The Lead route a conditional fill wrote, until the file confirms it.
  let filled = null;
  // Provider readiness may outlast the session the selection was made for.
  const adopted = lease.run(
    () => {
      // Compare-and-set: a route that already has a model (picked while this
      // selection was resolving) is never replaced. Checked synchronously with
      // the adopt below, so nothing can set a route in between. A Lead route
      // another process persisted may not have reached this runtime yet (the
      // change notification is debounced): the config is re-read from disk
      // right here, which adopts it and fills the empty route, and that route
      // is the winner this selection answers with.
      if (options?.onlyIfEmpty === true) {
        if (clean(getRoute()?.model)) return false;
        deps.reloadFullConfig?.();
        if (clean(getRoute()?.model)) return false;
      }
      if (options?.sessionOnly === true) {
        // An agent child's route belongs to that session alone: the shared
        // modelSettings bucket (saved effort/Fast per model) and the main
        // model (lead preset / default model) are never written.
        setRouteState(resolveRoute(getConfig(), selectedRoute));
      } else {
        persist.saveRouteModelSettings(selectedRoute, fastCapable);
        // The main model changes only on an explicit main-model choice
        // (keepMainModel: false, e.g. the setup tool); every other selection
        // — the session surface's model pick, an heir — keeps it.
        const leadRoute = persist.persistAdoptedModelSettings(persistedRoute, {
          keepMainModel: options?.keepMainModel !== false,
          onlyIfAbsent: options?.onlyIfEmpty === true,
        });
        filled = leadRoute;
        setRouteState(resolveRoute(getConfig(), leadRoute ? { model: workflowPresetId('lead') } : selectedRoute));
      }
      return true;
    },
    () => false
  );
  if (!adopted) return false;
  // A conditional fill reaches the file only while no Lead route is stored
  // there (judged under the config file lock). When another process wrote one
  // after the re-read above, the file's route replaces the fill in the runtime.
  const replaced = filled && (await deps.confirmLeadFill?.(filled)) === true;
  // The refresh completes against the route just adopted and only while the
  // selection still owns it.
  await refreshRouteEffort(replaced ? null : modelMeta, getRoute(), null, lease);
  return lease.run(
    () => {
      refreshStatuslineUsageSnapshot(getRoute());
      scheduleStatuslineUsageRefresh();
      return true;
    },
    () => false
  );
}

/**
 * Quota-exhaustion escape hatch: apply `next` to the addressed, ESTABLISHED
 * session in place. The caller (session API) has already proven the latest
 * settled turn failed on quota and that nothing is running. Starts no turn;
 * the next turn's auto-compaction fits history to the new window. Answers
 * `{ modelSwitch }` with the recorded boundary (as setRoute does) so the
 * session surface shows the same live divider, or true when nothing switched.
 */
export function createContinueSessionInModel(deps, persist, clearPendingRoute) {
  const { getSession, getSessionGeneration, invalidateContextStatusCache } = deps;
  return async function continueSessionInModel(sessionId, next) {
    const session = getSession();
    if (!sessionId || !session?.id || session.id !== sessionId) {
      throw new Error(`session ${sessionId || ''} is not the active session`);
    }
    const lease = openRouteLease(getSessionGeneration);
    const adopted = await adoptRoute(deps, persist, next, {}, lease);
    return lease.run(
      () => {
        if (!adopted) return true;
        const modelSwitch = switchSessionInPlace(deps, session);
        invalidateContextStatusCache();
        clearPendingRoute?.();
        return modelSwitch ? { modelSwitch } : true;
      },
      () => true
    );
  };
}

/** Rejects an unacceptable selection without applying it. */
async function validateSelectedRoute(deps, next) {
  await resolveSelectedRoute(deps, next);
  return deps.getRoute();
}

export function createSetRoute(deps, persist) {
  const { getRoute, getSession, getSessionGeneration, invalidateContextStatusCache, createCurrentSession } = deps;
  let pending = null;

  async function setRoute(next, options = {}) {
    // Without an explicit durable address a selection is for a new/inherited
    // session and never rewrites an existing conversation's model, unless it
    // is the user's model choice for this conversation (`switchEstablished`,
    // the session surface): that one switches an established conversation in
    // place while an empty one follows the unaddressed rules below.
    const applyToCurrentSession = options?.applyToCurrentSession === true;
    const switchEstablished = applyToCurrentSession || options?.switchEstablished === true;
    // Validate without persisting the selection or changing the session.
    if (options?.validateOnly === true) return validateSelectedRoute(deps, next);
    // A selection addressed to a conversation belongs to the session
    // generation it was enqueued under (the surface's enqueue boundary names
    // it; a direct call is enqueued now). Once that generation has moved, every
    // route or session effect is skipped by the lease and the current route
    // stands.
    const addressed = switchEstablished || options?.deferUntilNextTurn === true;
    const lease = addressed ? openRouteLease(getSessionGeneration, options?.originGeneration) : UNOWNED_LEASE;
    const adopted = await adoptRoute(deps, persist, next, options, lease);
    if (!adopted) return getRoute();
    return lease.run(() => followSession(options, lease, { switchEstablished, applyToCurrentSession }), getRoute);
  }

  /** What the adopted route does to the session it was selected for. */
  async function followSession(options, lease, { switchEstablished, applyToCurrentSession }) {
    const session = getSession();
    if (options.deferUntilNextTurn === true) {
      pending = session?.id ? { generation: lease.token } : null;
      return getRoute();
    }
    pending = null;
    // A session the user has already talked in or compacted keeps its route
    // unless the selection was addressed to it. A current session with no
    // model reply, no compaction summary and no in-flight first turn — empty,
    // or holding only refused prompts — takes effect live: route + statusline
    // update immediately. Only a truly empty session is recreated below.
    const currentSessionEmpty = !!session && !sessionRouteCommitted(session);
    if (!currentSessionEmpty) {
      if (!switchEstablished) return getRoute();
      const route = getRoute();
      // An addressed selection of another model switches the conversation
      // itself in place; the session surface defers it to the next turn
      // instead. A same-model update (effort/Fast) only tunes the session
      // from its next turn.
      if (session && (route.provider !== session.provider || route.model !== session.model)) {
        const modelSwitch = switchSessionInPlace(deps, session);
        invalidateContextStatusCache();
        return modelSwitch ? { ...getRoute(), modelSwitch } : getRoute();
      }
      persist.applySessionTuning();
      refreshSessionFallbacks(deps, session);
      return getRoute();
    }
    // An addressed runtime keeps its durable id: the empty session is updated
    // in place, never closed and replaced by a freshly minted one.
    if (
      !deps.getAddressedSessionId?.() &&
      shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession) &&
      session?.id &&
      typeof createCurrentSession === 'function'
    ) {
      // The recreation installs a new session itself, so nothing after it
      // acts for the selection beyond dropping the stale gauge.
      await recreateEmptySession(deps, lease);
      invalidateContextStatusCache();
      return getRoute();
    }
    if (session) {
      // An explicitly addressed daemon/desktop mutation must keep that
      // durable address. The caller asked to apply this route to THIS empty
      // session, so update it in place instead of closing A and silently
      // materializing B before the first prompt.
      updateSessionInPlace(deps, session);
      invalidateContextStatusCache();
    }
    return getRoute();
  }
  setRoute.applyPendingRoute = () => {
    if (!pending) return null;
    const selection = pending;
    if (selection.generation !== getSessionGeneration()) {
      pending = null;
      return null;
    }
    // The live route is the latest selection: effort/Fast tuned after the
    // deferred model choice replace it, so no snapshot is kept.
    const modelSwitch = switchSessionInPlace(deps, getSession());
    invalidateContextStatusCache();
    pending = null;
    return modelSwitch;
  };
  setRoute.clearPendingRoute = () => {
    pending = null;
  };
  return setRoute;
}
