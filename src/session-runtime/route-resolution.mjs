// Route resolution against the live runtime record: refuse a model-less first
// turn (no auto-pick) and refresh the route's effort / Fast / context
// fields from provider metadata.
import { ensureProviderEnabled } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { effortItemsFor } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';
import { normalizeContextTokens } from '../runtime/shared/llm/default-context-window.mjs';
import { resolveRouteContextState, resolveRouteEffortState, routeModelDisplay } from './route-state.mjs';

export function createRouteResolution({ rt, collectProviderModels, ensureProvidersReady, lookupModelMeta }) {
  function routeHasModel() {
    return !!clean(rt.route?.model);
  }

  function requireModelRoute() {
    if (routeHasModel()) return;
    throw new Error('No model configured. Open /providers to sign in, then /model to choose a model.');
  }

  async function resolveMissingRouteModelForFirstTurn(signal = null) {
    if (routeHasModel()) return rt.route;
    const models = await runAbortable(signal, () => collectProviderModels());
    throwIfAborted(signal);
    // A model chosen during the catalog read stands: a new task's reservation
    // prewarm starts on the empty route, its draft model lands meanwhile, and
    // the first prompt joins this very prewarm.
    if (routeHasModel()) return rt.route;
    if (!models?.length) {
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    // Never auto-pick: the user chooses the model.
    throw new Error('No model selected. Choose a model with /model first.');
  }

  async function refreshRouteEffort(modelMetaOverride = null, expectedRoute = null, signal = null, lease = null) {
    const targetRoute = expectedRoute || rt.route;
    await runAbortable(signal, () => ensureProvidersReady(ensureProviderEnabled(rt.config, targetRoute.provider)));
    const modelMeta =
      modelMetaOverride || (await runAbortable(signal, () => lookupModelMeta(targetRoute.provider, targetRoute.model)));
    throwIfAborted(signal);
    // A rapid second resume/model change can replace the route while provider
    // metadata is loading. Never let the older completion overwrite it.
    // A selection whose session was replaced while this loaded owns nothing.
    if (expectedRoute && rt.route !== expectedRoute) return null;
    if (lease && !lease.valid()) return null;
    const { effectiveEffort, fastCapable } = resolveRouteEffortState(targetRoute, modelMeta);
    const contextState = resolveRouteContextState(targetRoute, modelMeta);
    const contextValue = clean(targetRoute.modelParameters?.context);
    const contextOption = (modelMeta?.modelParameterOptions || [])
      .find((option) => option?.id === 'context')
      ?.options?.find((option) => clean(option?.value) === contextValue);
    const modelDisplay = routeModelDisplay(rt.config, targetRoute, modelMeta);
    // Without a known window the selection (share, exact tokens, resolved
    // window) is kept as requested — the session sizes it from the provider's
    // window; dropping it silently put the route back on the model's default.
    // With one it is the clamped value, absent when it is the default window.
    const windowKnown = contextState.contextDefaultPercent !== undefined;
    const selectedContextWindow = [
      contextState.selectedContextWindow,
      contextOption?.contextWindow,
      windowKnown ? undefined : targetRoute.selectedContextWindow,
    ]
      .map(Number)
      .find((value) => value > 0);
    const contextTokens = windowKnown ? contextState.contextTokens : normalizeContextTokens(targetRoute.contextTokens);
    const { contextTokens: _requestedTokens, ...routeFields } = targetRoute;
    rt.route = {
      ...routeFields,
      fast: fastCapable ? targetRoute.fast === true : false,
      fastCapable,
      effectiveEffort,
      effortOptions: effortItemsFor(rt.route.provider, modelMeta, effectiveEffort),
      contextPercent: windowKnown ? contextState.contextPercent : targetRoute.contextPercent,
      contextDefaultPercent: contextState.contextDefaultPercent,
      ...(contextTokens ? { contextTokens } : {}),
      ...(selectedContextWindow ? { selectedContextWindow } : {}),
      ...(modelDisplay ? { modelDisplay } : {}),
    };
    return rt.route;
  }

  return { routeHasModel, requireModelRoute, resolveMissingRouteModelForFirstTurn, refreshRouteEffort };
}
