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

export function filterModelEditTools(tools, modelName) {
  const selected = modelEditToolName(modelName);
  return (Array.isArray(tools) ? tools : []).filter((tool) => {
    const name = String(tool?.name || '').toLowerCase();
    return !MODEL_EDIT_TOOL_NAMES.has(name) || name === selected;
  });
}

export function filterModelEditToolNames(names, modelName) {
  const selected = modelEditToolName(modelName);
  return (Array.isArray(names) ? names : []).filter((name) => {
    const key = String(name || '').toLowerCase();
    return !MODEL_EDIT_TOOL_NAMES.has(key) || key === selected;
  });
}
