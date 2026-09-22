// model-picker/route-selection/fast-parameters.mjs
// Fast and the thinking-style model parameters of one model row. They are one
// module because they decide each other: availability of Fast is read off the
// selected parameters (and the selected effort), and cycling `thinking` can
// invalidate a Fast selection that the new parameter combination rules out.
import { modelKey } from './model-key.mjs';

export function createFastParameterSelection({ state, currentRoute, isCurrentRoute, isStateRoute, getSelectedEffort }) {
  const selectedFast = new Map();
  const selectedModelParameters = new Map();

  const modelParametersFor = (model) => {
    const key = modelKey(model);
    if (selectedModelParameters.has(key)) return selectedModelParameters.get(key);
    const current = isCurrentRoute(model) ? currentRoute.modelParameters : null;
    const saved = model.savedModelParameters || {};
    const defaults = { ...(model.defaultModelParameters || {}), ...saved, ...(current || {}) };
    const values = Object.fromEntries(
      (model.modelParameterOptions || []).flatMap((parameter) => {
        const selected = parameter.options?.some((option) => option.value === defaults[parameter.id])
          ? defaults[parameter.id]
          : parameter.options?.[0]?.value;
        return selected ? [[parameter.id, selected]] : [];
      })
    );
    selectedModelParameters.set(key, values);
    return values;
  };

  const fastAvailableFor = (model, effort = getSelectedEffort(model)) => {
    if (!model?.fastCapable) return false;
    if (Array.isArray(model.parameterVariants) && model.parameterVariants.length) {
      const parameters = modelParametersFor(model);
      return model.parameterVariants.some(
        (variant) =>
          variant.fast === 'true' &&
          (!effort || !variant.effort || variant.effort === effort) &&
          Object.entries(parameters).every(([key, value]) => !variant[key] || variant[key] === value)
      );
    }
    const fastEfforts = Array.isArray(model.fastEfforts) ? model.fastEfforts : [];
    return fastEfforts.length === 0 || fastEfforts.includes(effort || '');
  };
  const modelDefaultFast = (model) => {
    if (!fastAvailableFor(model)) return false;
    if (isCurrentRoute(model) && typeof currentRoute.fast === 'boolean') return currentRoute.fast;
    if (isStateRoute(model) && typeof state.fast === 'boolean') return state.fast;
    if (typeof model.savedFast === 'boolean') return model.savedFast;
    return model.fastPreferred === true;
  };
  const getSelectedFast = (model) => {
    if (!model || !fastAvailableFor(model)) return false;
    const key = modelKey(model);
    if (selectedFast.has(key)) return selectedFast.get(key) === true;
    const fast = modelDefaultFast(model);
    selectedFast.set(key, fast);
    return fast;
  };
  /** Flips Fast; false when the model cannot run Fast at the selected effort. */
  const toggleFast = (model) => {
    if (!fastAvailableFor(model)) return false;
    selectedFast.set(modelKey(model), !getSelectedFast(model));
    return true;
  };

  /** Cycles the 'thinking' parameter to its next option; false when the model
   *  has none. Fast is dropped when the new parameters rule it out. */
  const cycleThinking = (model) => {
    const wanted = 'thinking';
    const definition = (model.modelParameterOptions || []).find((parameter) => parameter.id === wanted);
    if (!definition?.options?.length) return false;
    const parameters = modelParametersFor(model);
    const current = Math.max(
      0,
      definition.options.findIndex((option) => option.value === parameters[wanted])
    );
    parameters[wanted] = definition.options[(current + 1) % definition.options.length].value;
    selectedModelParameters.set(modelKey(model), { ...parameters });
    if (!fastAvailableFor(model)) selectedFast.set(modelKey(model), false);
    return true;
  };

  return { modelParametersFor, fastAvailableFor, getSelectedFast, toggleFast, cycleThinking };
}
