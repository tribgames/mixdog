// model-picker/route-selection/effort.mjs
// The effort selection of one provider's model list: the seed order (route →
// UI state → saved → catalog default → preference), the per-row choice and the
// wrap-around cycle Left/Right drives.
import { modelKey } from './model-key.mjs';

const EFFORT_PREFERENCE = ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra'];

const preferredEffort = (values = []) => {
  const allowed = values.filter(Boolean);
  for (const value of EFFORT_PREFERENCE) {
    if (allowed.includes(value)) return value;
  }
  return allowed[0] || null;
};

export const effortItemsFor = (model) =>
  Array.isArray(model?.effortOptions) && model.effortOptions.length > 0 ? model.effortOptions : [];

export const modelEffortValues = (model) =>
  effortItemsFor(model)
    .map((effort) => effort.value)
    .filter(Boolean);

export function createEffortSelection({ providerModels, state, currentRoute, isCurrentRoute, isStateRoute }) {
  const selectedEfforts = new Map();

  const modelDefaultEffort = (model) => {
    const values = modelEffortValues(model);
    if (!values.length) return null;
    if (isCurrentRoute(model) && currentRoute.effort && values.includes(currentRoute.effort))
      return currentRoute.effort;
    if (isStateRoute(model) && state.effort && values.includes(state.effort)) return state.effort;
    if (model.savedEffort && values.includes(model.savedEffort)) return model.savedEffort;
    if (model.defaultEffort && values.includes(model.defaultEffort)) return model.defaultEffort;
    return preferredEffort(values);
  };
  const getSelectedEffort = (model) => {
    if (!model) return null;
    const key = modelKey(model);
    if (selectedEfforts.has(key)) return selectedEfforts.get(key);
    const effort = modelDefaultEffort(model);
    selectedEfforts.set(key, effort);
    return effort;
  };
  const setSelectedEffort = (model, effort) => {
    if (!model) return;
    selectedEfforts.set(modelKey(model), effort || null);
  };

  /** Every effort offered by any model of this provider, first occurrence wins. */
  const providerEffortItems = () => {
    const seen = new Set();
    const out = [];
    for (const effort of providerModels.flatMap((model) => effortItemsFor(model))) {
      if (!effort?.value || seen.has(effort.value)) continue;
      seen.add(effort.value);
      out.push(effort);
    }
    return out;
  };
  const coerceEffort = (model) => {
    const values = modelEffortValues(model);
    if (!values.length) return null;
    const selectedEffort = getSelectedEffort(model);
    return values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
  };
  /** Moves the effort one step with wrap-around; false when the model has none. */
  const cycleEffort = (model, direction = 1) => {
    const values = modelEffortValues(model);
    if (values.length === 0) return false;
    const selectedEffort = getSelectedEffort(model);
    const currentValue = values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
    const current = values.includes(currentValue) ? values.indexOf(currentValue) : 0;
    setSelectedEffort(model, values[(current + direction + values.length) % values.length] || null);
    return true;
  };

  return {
    providerEffortItems,
    modelDefaultEffort,
    getSelectedEffort,
    setSelectedEffort,
    coerceEffort,
    cycleEffort,
  };
}
