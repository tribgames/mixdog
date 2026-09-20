// model-picker/route-selection.mjs
// The per-row selections of one provider's model list — effort, Fast, the
// thinking-style parameters and the context percent — seeded from the
// current route, the live UI state and the saved values, plus the route input
// Enter saves. Mutators return whether anything changed so the caller knows
// when to repaint.
import { modelContextWindow } from '../model-options.mjs';

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

const modelEffortValues = (model) =>
  effortItemsFor(model)
    .map((effort) => effort.value)
    .filter(Boolean);

const modelKey = (model) => `${model?.provider || ''}\n${model?.id || ''}`;

const clampPercent = (value) => Math.max(10, Math.min(100, value));

export function createRouteSelection({ providerModels, state, currentRoute }) {
  const isCurrentRoute = (model) => currentRoute?.provider === model.provider && currentRoute?.model === model.id;
  const isStateRoute = (model) => model.provider === state.provider && model.id === state.model;
  const selectedEfforts = new Map();
  const selectedFast = new Map();
  const selectedModelParameters = new Map();
  const selectedContextPercent = new Map();

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

  const contextSelectionFor = (model) => {
    const key = modelKey(model);
    const defaultWindow = modelContextWindow(model);
    const maxWindow = Math.max(defaultWindow, Number(model?.maxContextWindow) || 0);
    if (!maxWindow) return null;
    const defaultPercent = clampPercent(Math.round((defaultWindow / maxWindow) * 10) * 10);
    if (!selectedContextPercent.has(key)) {
      let requested = model.savedContextPercent;
      if (isCurrentRoute(model)) {
        requested = currentRoute.contextPercent;
      } else if (isStateRoute(model)) {
        requested = state.contextPercent;
      }
      const percent =
        Number.isFinite(Number(requested)) && Number(requested) > 0
          ? clampPercent(Math.round(Number(requested) / 10) * 10)
          : defaultPercent;
      selectedContextPercent.set(key, percent);
    }
    const percent = selectedContextPercent.get(key);
    return {
      percent,
      defaultPercent,
      tokens: percent === defaultPercent ? defaultWindow : Math.floor((maxWindow * percent) / 100),
    };
  };
  /** Steps the context one 10% notch; false when the model has no window. */
  const stepContext = (model, direction = 1) => {
    const context = contextSelectionFor(model);
    if (!context) return false;
    selectedContextPercent.set(modelKey(model), clampPercent(context.percent + direction * 10));
    return true;
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

  /** The route Enter saves for this model, with the effort it was coerced to. */
  const routeInputFor = (selected) => {
    const effort = coerceEffort(selected);
    const fastCapable = fastAvailableFor(selected, effort);
    const context = contextSelectionFor(selected);
    return {
      effort,
      routeInput: {
        provider: selected.provider,
        model: selected.id,
        ...(effort ? { effort } : {}),
        ...(context ? { contextPercent: context.percent } : {}),
        ...(selected.fastCapable ? { fast: fastCapable && getSelectedFast(selected) } : {}),
        ...((selected.modelParameterOptions || []).length ? { modelParameters: modelParametersFor(selected) } : {}),
      },
    };
  };

  return {
    providerEffortItems,
    modelDefaultEffort,
    getSelectedEffort,
    setSelectedEffort,
    modelParametersFor,
    contextSelectionFor,
    stepContext,
    fastAvailableFor,
    getSelectedFast,
    toggleFast,
    cycleEffort,
    cycleThinking,
    routeInputFor,
  };
}
