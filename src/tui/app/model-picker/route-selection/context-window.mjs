// model-picker/route-selection/context-window.mjs
// The context-window selection of one model row: the 10% notch the route/state/
// saved value seeds, the tokens it resolves to, and the step Left/Right drives.
import { modelContextWindow } from '../../model-options.mjs';
import { modelKey } from './model-key.mjs';

const clampPercent = (value) => Math.max(10, Math.min(100, value));

export function createContextSelection({ state, currentRoute, isCurrentRoute, isStateRoute }) {
  const selectedContextPercent = new Map();

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

  return { contextSelectionFor, stepContext };
}
