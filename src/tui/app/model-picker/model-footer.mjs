// model-picker/model-footer.mjs
// The footer rows under the highlighted model: the selected effort with its
// glyph, the context percent, Fast, and the remaining parameters.
import { theme } from '../../theme.mjs';
import { effortDisplayLabel, fastDisplayLabel, formatContextWindow } from '../model-options.mjs';
import { effortItemsFor } from './route-selection.mjs';

const EFFORT_GLYPHS = new Map([
  ['none', '○'],
  ['low', '◔'],
  ['medium', '◑'],
  ['high', '◕'],
  ['max', '◆'],
  ['ultra', '✦'],
]);

// Theme keys, resolved at call time so a theme switch re-tones the footer.
const EFFORT_COLOR_KEYS = new Map([
  ['none', 'inactive'],
  ['low', 'warning'],
  ['medium', 'claude'],
  ['high', 'error'],
  ['max', 'permission'],
  ['ultra', 'permission'],
]);

const effortGlyph = (value) => EFFORT_GLYPHS.get(value) ?? '●';

const effortColor = (value) => theme[EFFORT_COLOR_KEYS.get(value) ?? 'error'];

const effortLabel = (selection, value) => {
  const found = selection.providerEffortItems().find((effort) => effort.value === value);
  return effortDisplayLabel(found?.label || value || '');
};

export function modelFooter(selection, model = null) {
  const items = model ? effortItemsFor(model) : selection.providerEffortItems();
  const values = items.map((effort) => effort.value).filter(Boolean);
  const context = model ? selection.contextSelectionFor(model) : null;
  let contextLine = null;
  if (context) {
    const isDefault = context.percent === context.defaultPercent;
    contextLine = {
      glyph: '▣',
      color: isDefault ? theme.inactive : theme.permission,
      text: `${context.percent}% · ${formatContextWindow(context.tokens)}${isDefault ? ' · Default' : ''} · C/Shift+C Adjust`,
    };
  }
  const fastCapable = selection.fastAvailableFor(model);
  const fastOn = fastCapable && selection.getSelectedFast(model);
  let fastLine = null;
  if (fastCapable) {
    fastLine = {
      glyph: fastOn ? '●' : '○',
      color: fastOn ? theme.fastMode : theme.inactive,
      text: `${fastDisplayLabel(fastOn)} · Tab Toggle`,
    };
  }
  const parameterLines = (model?.modelParameterOptions || [])
    .filter((parameter) => parameter.id !== 'context')
    .map((parameter) => {
      const value = selection.modelParametersFor(model)[parameter.id] || '';
      return {
        glyph: '◇',
        color: theme.inactive,
        text: `${parameter.label}: ${parameter.options?.find((option) => option.value === value)?.label || value} · T Toggle`,
      };
    });
  if (!values.length)
    return [...(contextLine ? [contextLine] : []), ...(fastLine ? [fastLine] : []), ...parameterLines];
  let selectedEffort = selection.getSelectedEffort(model);
  if (!values.includes(selectedEffort)) {
    selectedEffort = selection.modelDefaultEffort(model);
    selection.setSelectedEffort(model, selectedEffort);
  }
  const effortLine = {
    glyph: effortGlyph(selectedEffort),
    color: effortColor(selectedEffort),
    text: `${effortLabel(selection, selectedEffort)} Effort ←/→ To Adjust`,
  };
  return [effortLine, ...(contextLine ? [contextLine] : []), ...(fastLine ? [fastLine] : []), ...parameterLines];
}
