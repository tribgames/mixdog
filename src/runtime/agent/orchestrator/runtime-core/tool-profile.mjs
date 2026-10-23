import { HEARTBEAT_SOURCE } from '../../../shared/routine-trigger.mjs';

const INTERACTIVE_TOOL_PROFILE = 'interactive';
export const HEADLESS_TOOL_PROFILE = 'headless';
// Mixy's hidden heartbeat session (session-runtime/mixy-heartbeat.mjs): it
// judges a reviewed digest, so it reads sessions and bots, records proposals
// (session) and pauses or reruns a routine (setup); nothing else.
export const HEARTBEAT_TOOL_PROFILE = 'heartbeat';

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
  'github',
  'shell',
  'task',
  'load_tool',
  'web_search',
  'web_fetch',
  'office',
  'tidy',
]);

// load_tool loads the two deferred tools' schemas.
export const HEARTBEAT_MODEL_TOOL_NAMES = Object.freeze(['session', 'setup', 'load_tool']);

// The model tools each narrowed profile allows; the interactive profile has no list.
const PROFILE_TOOL_NAMES = new Map([
  [HEADLESS_TOOL_PROFILE, HEADLESS_MODEL_TOOL_NAMES],
  [HEARTBEAT_TOOL_PROFILE, HEARTBEAT_MODEL_TOOL_NAMES],
]);
const PROFILE_TOOL_SETS = new Map(
  [...PROFILE_TOOL_NAMES].map(([profile, names]) => [profile, new Set(names.map((name) => name.toLowerCase()))])
);

export function normalizeToolProfile(value) {
  const profile = String(value || '')
    .trim()
    .toLowerCase();
  return PROFILE_TOOL_NAMES.has(profile) ? profile : INTERACTIVE_TOOL_PROFILE;
}

/** The profile a session runtime runs under: a session created as a heartbeat
 *  run (source `heartbeat`) is fenced to the heartbeat tools whatever profile
 *  was asked for. The source only ever narrows, so a forged one costs nothing. */
export function sessionToolProfile({ toolProfile, sessionProfile } = {}) {
  if (String(sessionProfile?.sourceName || '').trim() === HEARTBEAT_SOURCE) return HEARTBEAT_TOOL_PROFILE;
  return normalizeToolProfile(toolProfile);
}

export function modelToolSchemaAllowlist(profile) {
  const names = PROFILE_TOOL_NAMES.get(normalizeToolProfile(profile));
  return names ? [...names] : null;
}

export function modelToolAllowedForProfile(name, profile) {
  const allowed = PROFILE_TOOL_SETS.get(normalizeToolProfile(profile));
  if (!allowed) return true;
  return allowed.has(
    String(name || '')
      .trim()
      .toLowerCase()
  );
}

export function filterModelToolsForProfile(tools, profile) {
  const rows = Array.isArray(tools) ? tools : [];
  if (!PROFILE_TOOL_SETS.has(normalizeToolProfile(profile))) return rows;
  return rows.filter((tool) => modelToolAllowedForProfile(tool?.name, profile));
}

export function disallowedModelToolNamesForProfile(tools, profile) {
  if (!PROFILE_TOOL_SETS.has(normalizeToolProfile(profile))) return [];
  return [
    ...new Set(
      (Array.isArray(tools) ? tools : [])
        .map((tool) => String(tool?.name || '').trim())
        .filter((name) => name && !modelToolAllowedForProfile(name, profile))
    ),
  ];
}
