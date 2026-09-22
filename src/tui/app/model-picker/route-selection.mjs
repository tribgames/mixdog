// model-picker/route-selection.mjs
// The per-row selections of one provider's model list — effort, Fast, the
// thinking-style parameters and the context percent — seeded from the
// current route, the live UI state and the saved values, plus the route input
// Enter saves. Mutators return whether anything changed so the caller knows
// when to repaint.
//
// The three selection families live in route-selection/ (effort, Fast +
// parameters, context window); this file seeds them from the same route/state
// pair and assembles the route input from all three.
import { createContextSelection } from './route-selection/context-window.mjs';
import { createEffortSelection, effortItemsFor } from './route-selection/effort.mjs';
import { createFastParameterSelection } from './route-selection/fast-parameters.mjs';

export { effortItemsFor };

export function createRouteSelection({ providerModels, state, currentRoute }) {
  const isCurrentRoute = (model) => currentRoute?.provider === model.provider && currentRoute?.model === model.id;
  const isStateRoute = (model) => model.provider === state.provider && model.id === state.model;
  const seeds = { state, currentRoute, isCurrentRoute, isStateRoute };

  const effort = createEffortSelection({ providerModels, ...seeds });
  const fast = createFastParameterSelection({ ...seeds, getSelectedEffort: effort.getSelectedEffort });
  const context = createContextSelection(seeds);

  /** The route Enter saves for this model, with the effort it was coerced to. */
  const routeInputFor = (selected) => {
    const coercedEffort = effort.coerceEffort(selected);
    const fastCapable = fast.fastAvailableFor(selected, coercedEffort);
    const contextSelection = context.contextSelectionFor(selected);
    return {
      effort: coercedEffort,
      routeInput: {
        provider: selected.provider,
        model: selected.id,
        ...(coercedEffort ? { effort: coercedEffort } : {}),
        ...(contextSelection ? { contextPercent: contextSelection.percent } : {}),
        ...(selected.fastCapable ? { fast: fastCapable && fast.getSelectedFast(selected) } : {}),
        ...((selected.modelParameterOptions || []).length
          ? { modelParameters: fast.modelParametersFor(selected) }
          : {}),
      },
    };
  };

  return {
    providerEffortItems: effort.providerEffortItems,
    modelDefaultEffort: effort.modelDefaultEffort,
    getSelectedEffort: effort.getSelectedEffort,
    setSelectedEffort: effort.setSelectedEffort,
    modelParametersFor: fast.modelParametersFor,
    contextSelectionFor: context.contextSelectionFor,
    stepContext: context.stepContext,
    fastAvailableFor: fast.fastAvailableFor,
    getSelectedFast: fast.getSelectedFast,
    toggleFast: fast.toggleFast,
    cycleEffort: effort.cycleEffort,
    cycleThinking: fast.cycleThinking,
    routeInputFor,
  };
}
