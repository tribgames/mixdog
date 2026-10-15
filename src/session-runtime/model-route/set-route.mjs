/**
 * set-route.mjs — select the main route: resolve and validate the request,
 * adopt it into config, then decide how the current session follows it
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
async function recreateEmptySession(deps) {
  const { getSession, setSession, mgr, statusRoutes, createCurrentSession, invalidatePreSessionToolSurface } = deps;
  // If the boot create is still finishing SessionStart/deferred-surface
  // work, drain that promise first. Otherwise createCurrentSession()
  // would return the old in-flight promise after we tombstone/null the
  // session, racing the intended rebuild for the new provider.
  await createCurrentSession('model-switch-empty-drain');
  const emptySession = getSession();
  if (!emptySession?.id || sessionHasRouteHistory(emptySession)) return;
  statusRoutes?.clearGatewaySessionRoute?.(emptySession.id);
  mgr.closeSession?.(emptySession.id, 'cli-model-switch-empty', { tombstone: true });
  setSession(null);
  invalidatePreSessionToolSurface?.();
  await createCurrentSession('model-switch-empty');
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
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const index = modelSwitchAnchorIndex(messages);
  if (index < 0) return false;
  const anchor = messages[index];
  const switches = Array.isArray(anchor.meta?.modelSwitches) ? anchor.meta.modelSwitches : [];
  if (switches.some((entry) => entry?.at === boundary.at && entry?.modelId === boundary.modelId)) return true;
  // Replace the message object: the session save worker detects changed
  // messages by reference identity, so an in-place meta edit is never saved.
  messages[index] = { ...anchor, meta: { ...anchor.meta, modelSwitches: [...switches, boundary] } };
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

/** Validate, persist and adopt the requested route as the runtime's route. */
async function adoptRoute(deps, persist, next, options) {
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
  persist.saveRouteModelSettings(selectedRoute, fastCapable);
  // An heir opening on its source's model is not a main-model choice.
  const leadRoute = persist.persistAdoptedModelSettings(selectedRoute, {
    keepMainModel: options?.keepMainModel === true,
  });
  setRouteState(resolveRoute(getConfig(), leadRoute ? { model: workflowPresetId('lead') } : selectedRoute));
  await refreshRouteEffort(modelMeta);
  refreshStatuslineUsageSnapshot(getRoute());
  scheduleStatuslineUsageRefresh();
}

/**
 * Quota-exhaustion escape hatch: apply `next` to the addressed, ESTABLISHED
 * session in place. The caller (session API) has already proven the latest
 * settled turn failed on quota and that nothing is running. Starts no turn;
 * the next turn's auto-compaction fits history to the new window. Answers
 * `{ modelSwitch }` with the recorded boundary (as setRoute does) so the
 * session surface shows the same live divider, or true when nothing switched.
 */
export function createContinueSessionInModel(deps, persist) {
  const { getSession, invalidateContextStatusCache } = deps;
  return async function continueSessionInModel(sessionId, next) {
    const session = getSession();
    if (!sessionId || !session?.id || session.id !== sessionId) {
      throw new Error(`session ${sessionId || ''} is not the active session`);
    }
    await adoptRoute(deps, persist, next, {});
    const modelSwitch = switchSessionInPlace(deps, session);
    invalidateContextStatusCache();
    return modelSwitch ? { modelSwitch } : true;
  };
}

/** Rejects an unacceptable selection without applying it. */
async function validateSelectedRoute(deps, next) {
  await resolveSelectedRoute(deps, next);
  return deps.getRoute();
}

export function createSetRoute(deps, persist) {
  const { getRoute, getSession, invalidateContextStatusCache, createCurrentSession } = deps;

  return async function setRoute(next, options = {}) {
    // Without an explicit durable address a selection is for a new/inherited
    // session and never rewrites an existing conversation's model, unless it
    // is the user's model choice for this conversation (`switchEstablished`,
    // the session surface): that one switches an established conversation in
    // place while an empty one follows the unaddressed rules below.
    const applyToCurrentSession = options?.applyToCurrentSession === true;
    const switchEstablished = applyToCurrentSession || options?.switchEstablished === true;
    // Lets a caller prove the selection is acceptable before it does
    // irreversible work (compaction) ahead of the switch; changes nothing.
    if (options?.validateOnly === true) return validateSelectedRoute(deps, next);
    await adoptRoute(deps, persist, next, options);
    const session = getSession();
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
      // itself in place; the caller (session surface) refuses it while a
      // turn runs. A same-model update (effort/Fast) only tunes the session
      // from its next turn.
      if (session && (route.provider !== session.provider || route.model !== session.model)) {
        const modelSwitch = switchSessionInPlace(deps, session);
        invalidateContextStatusCache();
        return modelSwitch ? { ...getRoute(), modelSwitch } : getRoute();
      }
      persist.applySessionTuning();
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
      await recreateEmptySession(deps);
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
  };
}
