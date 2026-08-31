export const INTERACTIVE_TOOL_PROFILE = 'interactive';
export const HEADLESS_TOOL_PROFILE = 'headless';

export const HEADLESS_MODEL_TOOL_NAMES = Object.freeze([
  'find',
  'glob',
  'list',
  'grep',
  'code_graph',
  'read',
  'edit',
  'apply_patch',
  'git',
  'git_stage',
  'shell',
  'task',
  'load_tool',
  'web_search',
  'web_fetch',
  'office',
]);

const HEADLESS_MODEL_TOOL_SET = new Set(
  HEADLESS_MODEL_TOOL_NAMES.map((name) => name.toLowerCase()),
);

export function normalizeToolProfile(value) {
  return String(value || '').trim().toLowerCase() === HEADLESS_TOOL_PROFILE
    ? HEADLESS_TOOL_PROFILE
    : INTERACTIVE_TOOL_PROFILE;
}

export function modelToolSchemaAllowlist(profile) {
  return normalizeToolProfile(profile) === HEADLESS_TOOL_PROFILE
    ? [...HEADLESS_MODEL_TOOL_NAMES]
    : null;
}

export function modelToolAllowedForProfile(name, profile) {
  if (normalizeToolProfile(profile) !== HEADLESS_TOOL_PROFILE) return true;
  return HEADLESS_MODEL_TOOL_SET.has(String(name || '').trim().toLowerCase());
}

export function filterModelToolsForProfile(tools, profile) {
  const rows = Array.isArray(tools) ? tools : [];
  if (normalizeToolProfile(profile) !== HEADLESS_TOOL_PROFILE) return rows;
  return rows.filter((tool) => modelToolAllowedForProfile(tool?.name, profile));
}

export function disallowedModelToolNamesForProfile(tools, profile) {
  if (normalizeToolProfile(profile) !== HEADLESS_TOOL_PROFILE) return [];
  return [...new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => String(tool?.name || '').trim())
      .filter((name) => name && !modelToolAllowedForProfile(name, profile)),
  )];
}
