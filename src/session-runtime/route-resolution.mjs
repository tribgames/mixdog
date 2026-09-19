// Route resolution against the live runtime record: pick a model for a
// model-less first turn and refresh the route's effort / Fast / context
// fields from provider metadata.
import { ensureProviderEnabled } from './config-helpers.mjs';
import { clean, hasOwn } from './session-text.mjs';
import { effortItemsFor } from './effort.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';
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
    const picked = models[0] || null;
    if (!picked) {
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    rt.route = {
      ...rt.route,
      provider: picked.provider,
      model: picked.id,
      preset: null,
    };
    return rt.route;
  }

  async function refreshRouteEffort(modelMetaOverride = null, expectedRoute = null, signal = null) {
    const targetRoute = expectedRoute || rt.route;
    await runAbortable(signal, () => ensureProvidersReady(ensureProviderEnabled(rt.config, targetRoute.provider)));
    const modelMeta =
      modelMetaOverride || (await runAbortable(signal, () => lookupModelMeta(targetRoute.provider, targetRoute.model)));
    throwIfAborted(signal);
    // A rapid second resume/model change can replace the route while provider
    // metadata is loading. Never let the older completion overwrite it.
    if (expectedRoute && rt.route !== expectedRoute) return null;
    const { effectiveEffort, fastCapable } = resolveRouteEffortState(targetRoute, modelMeta);
    const contextState = resolveRouteContextState(targetRoute, modelMeta);
    const contextValue = clean(targetRoute.modelParameters?.context);
    const contextOption = (modelMeta?.modelParameterOptions || [])
      .find((option) => option?.id === 'context')
      ?.options?.find((option) => clean(option?.value) === contextValue);
    const modelDisplay = routeModelDisplay(rt.config, targetRoute, modelMeta);
    const selectedContextWindow = [contextState.selectedContextWindow, contextOption?.contextWindow]
      .map(Number)
      .find((value) => value > 0);
    rt.route = {
      ...targetRoute,
      fast: fastCapable ? targetRoute.fast === true : false,
      fastCapable,
      effectiveEffort,
      effortOptions: effortItemsFor(rt.route.provider, modelMeta, effectiveEffort),
      contextPercent: contextState.contextPercent,
      contextDefaultPercent: contextState.contextDefaultPercent,
      ...(selectedContextWindow ? { selectedContextWindow } : {}),
      ...(modelDisplay ? { modelDisplay } : {}),
    };
    return rt.route;
  }

  return { routeHasModel, requireModelRoute, resolveMissingRouteModelForFirstTurn, refreshRouteEffort };
}
