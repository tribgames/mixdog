const MODEL_EDIT_TOOL_NAMES = new Set(['apply_patch', 'edit']);

export function isGptFamilyModel(modelName) {
  const leaf = String(modelName || '')
    .trim()
    .toLowerCase()
    .split('/')
    .pop() || '';
  return /^(?:chat)?gpt(?:[-_.\d]|$)/.test(leaf);
}

export function modelEditToolName(modelName) {
  return isGptFamilyModel(modelName) ? 'apply_patch' : 'edit';
}

/**
 * The edit dialect this model never receives. Rules that name a concrete edit
 * tool are gated on it, so a session only reads the dialect it can call.
 */
export function unusedModelEditToolName(modelName) {
  return modelEditToolName(modelName) === 'edit' ? 'apply_patch' : 'edit';
}

// Static tool descriptions name both dialects with this token; the surface
// rewrites it to the one dialect the session can call, so a Claude session
// never reads `apply_patch` and a GPT session never reads `edit`.
export const EDIT_DIALECT_TOKEN = 'edit/apply_patch';

function bindEditDialectDescription(tool, selected) {
  const description = tool?.description;
  if (typeof description !== 'string' || !description.includes(EDIT_DIALECT_TOKEN)) return tool;
  return { ...tool, description: description.split(EDIT_DIALECT_TOKEN).join(selected) };
}

export function filterModelEditTools(tools, modelName) {
  const selected = modelEditToolName(modelName);
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => {
      const name = String(tool?.name || '').toLowerCase();
      return !MODEL_EDIT_TOOL_NAMES.has(name) || name === selected;
    })
    .map((tool) => bindEditDialectDescription(tool, selected));
}

export function filterModelEditToolNames(names, modelName) {
  const selected = modelEditToolName(modelName);
  return (Array.isArray(names) ? names : []).filter((name) => {
    const key = String(name || '').toLowerCase();
    return !MODEL_EDIT_TOOL_NAMES.has(key) || key === selected;
  });
}
