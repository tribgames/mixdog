/**
 * route-tuning.mjs — fast and effort changes on the current main route.
 */
import { normalizeEffortInput } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { selectionFastCapable } from '../route-state.mjs';
import { ultrafastCapableFor } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { workflowPresetId } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';

export function createRouteTuning(deps, persist) {
  const { getConfig, getRoute, setRouteState, resolveRoute, lookupModelMeta, refreshRouteEffort } = deps;

  /** Save the live route's modelSettings, re-resolve through the lead preset
   *  when one exists, refresh effort and tune the current session.
   *
   *  This is not a Main-model write and needs no compare-and-set: it persists
   *  the LIVE route (read after every await), and only when that route's model
   *  is already the Main model (persistAdoptedModelSettings: tunesNonMainModel),
   *  so the lead preset's model is rewritten with itself and never changes. A
   *  live route without a model normalizes to nothing and writes no preset. */
  async function commitRouteTuning(fastCapable, modelMeta) {
    persist.saveRouteModelSettings(getRoute(), fastCapable);
    const leadRoute = persist.persistAdoptedModelSettings(getRoute());
    if (leadRoute) setRouteState(resolveRoute(getConfig(), { model: workflowPresetId('lead') }));
    await refreshRouteEffort(modelMeta);
    persist.applySessionTuning();
  }

  async function setFast(value) {
    const ultra = value === 'ultrafast';
    const enabled = value === true || ultra;
    const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
    // lookupModelMeta may answer with the provider's raw (unhydrated) model, so
    // ask the capability directly instead of the row's serviceTier option.
    if (ultra && !ultrafastCapableFor(getRoute().provider, modelMeta)) {
      throw new Error(`ultrafast is not available for ${getRoute().provider}/${getRoute().model}`);
    }
    const { serviceTier: previousTier, ...otherParameters } = getRoute().modelParameters || {};
    let modelParameters = getRoute().modelParameters;
    if (ultra) modelParameters = { ...otherParameters, serviceTier: 'ultrafast' };
    else if (previousTier === 'ultrafast') modelParameters = otherParameters;
    const fastCapable = selectionFastCapable(
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
        modelParameters,
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
      // An explicit level is the user's choice for this route: Auto effort
      // would replace it on the next turn (its base is fixed), so the pick
      // turns the route's Auto off until it is switched back on.
      setRouteState({ ...getRoute(), effort: normalized, ...(normalized ? { autoEffort: false } : {}) });
      const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
      const fastCapable = selectionFastCapable(getRoute().provider, modelMeta, normalized, getRoute().modelParameters);
      await commitRouteTuning(fastCapable, modelMeta);
      return getRoute();
    },
  };
}
