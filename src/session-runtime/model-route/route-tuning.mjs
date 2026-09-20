/**
 * route-tuning.mjs — fast and effort changes on the current main route.
 */
import { normalizeEffortInput } from '../effort.mjs';
import { fastCapableFor } from '../model-capabilities.mjs';
import { workflowPresetId } from '../workflow.mjs';

export function createRouteTuning(deps, persist) {
  const { getConfig, getRoute, setRouteState, resolveRoute, lookupModelMeta, refreshRouteEffort } = deps;

  /** Save the live route's modelSettings, re-resolve through the lead preset
   *  when one exists, refresh effort and tune the current session. */
  async function commitRouteTuning(fastCapable, modelMeta) {
    persist.saveRouteModelSettings(getRoute(), fastCapable);
    const leadRoute = persist.persistAdoptedModelSettings(getRoute());
    if (leadRoute) setRouteState(resolveRoute(getConfig(), { model: workflowPresetId('lead') }));
    await refreshRouteEffort(modelMeta);
    persist.applySessionTuning();
  }

  async function setFast(value) {
    const enabled = value === true;
    const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
    const fastCapable = fastCapableFor(
      getRoute().provider,
      modelMeta,
      getRoute().effectiveEffort || getRoute().effort,
      getRoute().modelParameters
    );
    if (enabled && !fastCapable) {
      throw new Error(`fast mode is not available for ${getRoute().provider}/${getRoute().model}`);
    }
    setRouteState(
      resolveRoute(getConfig(), {
        provider: getRoute().provider,
        model: getRoute().model,
        effort: getRoute().effort,
        fast: fastCapable ? enabled : false,
        modelParameters: getRoute().modelParameters,
      })
    );
    await commitRouteTuning(fastCapable, modelMeta);
    return getRoute().fast === true;
  }

  return {
    setFast,
    async toggleFast() {
      return await setFast(!(getRoute().fast === true));
    },
    async setEffort(value) {
      const normalized = normalizeEffortInput(value);
      setRouteState({ ...getRoute(), effort: normalized });
      const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
      const fastCapable = fastCapableFor(getRoute().provider, modelMeta, normalized, getRoute().modelParameters);
      await commitRouteTuning(fastCapable, modelMeta);
      return getRoute();
    },
  };
}
