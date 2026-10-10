/**
 * Defaults live in code; mixdog-config.json holds only what the user changed.
 *
 * - `stripAgentSectionDefaults` / `stripChannelsDefaults` drop values equal to
 *   the current default (used by every write path).
 * - `ensureDefaultsSeparated` is the one-time pass for files written before
 *   that rule: gated by the top-level `defaultsVersion` marker, it backs the
 *   file up first, then removes current/historical default values and turns
 *   the stored full `disabledAgents` list into a delta.
 *
 * Left untouched on purpose: `desktop`, credentials, onboarding, detection and
 * install flags, caches, and keys that are only ever hand-edited.
 */
import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { packDefinitionFromDir } from '../../session-runtime/services/defaults-separation.mjs';
import { resolvePluginData } from './plugin-paths.mjs';
import { hasOwn, isPlainObject } from './object.mjs';
import { DEFAULTS_VERSION, DEFAULTS_VERSION_KEY, configPath, readConfig, updateConfig } from './config.mjs';
import { DEFAULT_DISABLED_AGENT_ROSTER, disabledAgentDelta, disabledAgentIds } from './agent-route-config.mjs';
import { DEFAULT_ORCHESTRATION_MODE, legacyWorkflowOrchestrationMode } from './orchestration.mjs';

export { DEFAULTS_VERSION, DEFAULTS_VERSION_KEY };

export const DEFAULT_OUTPUT_STYLE = 'simple';

// Current defaults of the agent-section toggles that used to be materialized.
const AGENT_SECTION_DEFAULTS = Object.freeze({
  autoClear: Object.freeze({ enabled: true, minContextPercent: 10 }),
  compaction: Object.freeze({ auto: true }),
  update: Object.freeze({ auto: true }),
  recap: Object.freeze({ enabled: true }),
  memoryTools: Object.freeze({ enabled: true }),
});
const MODULE_DEFAULTS = Object.freeze({ enabled: true });

export const CHANNELS_DEFAULTS = Object.freeze({
  access: Object.freeze({ dmPolicy: 'allowlist', allowFrom: [], channels: {} }),
  webhook: Object.freeze({ enabled: true, port: 3333 }),
});

// Disabled-agent roster shipped before `advisor` joined the defaults
// (worker … writer plus the Maintainer). Stored full lists are read against it.
export const PREVIOUS_DISABLED_AGENT_ROSTER = Object.freeze([
  'front-worker',
  'heavy-worker',
  'maintainer',
  'reviewer',
  'security',
  'worker',
  'writer',
]);

// Values that were the shipped default in an earlier release.
const HISTORICAL_ORCHESTRATION_MODES = Object.freeze(['none']);

/** Copy of `value` without the keys whose value equals `defaults[key]`; undefined when nothing is left. */
function withoutDefaults(value, defaults) {
  if (!isPlainObject(value)) return value;
  const next = { ...value };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (hasOwn(next, key) && isDeepStrictEqual(next[key], fallback)) delete next[key];
  }
  return Object.keys(next).length ? next : undefined;
}

function setOrDelete(target, key, value) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

/** Drop agent-section values that equal the current default. */
export function stripAgentSectionDefaults(agent) {
  const next = { ...(agent || {}) };
  if (next.orchestrationMode === DEFAULT_ORCHESTRATION_MODE) delete next.orchestrationMode;
  if (isDeepStrictEqual(next.workflow, { active: 'default' })) delete next.workflow;
  for (const [key, defaults] of Object.entries(AGENT_SECTION_DEFAULTS)) {
    if (hasOwn(next, key)) setOrDelete(next, key, withoutDefaults(next[key], defaults));
  }
  if (isPlainObject(next.modules)) {
    const modules = {};
    for (const [name, entry] of Object.entries(next.modules)) {
      const kept = withoutDefaults(entry, MODULE_DEFAULTS);
      if (kept !== undefined) modules[name] = kept;
    }
    setOrDelete(next, 'modules', Object.keys(modules).length ? modules : undefined);
  }
  return next;
}

/** Drop channels values that equal the current default. */
export function stripChannelsDefaults(channels) {
  const next = { ...(channels || {}) };
  for (const key of Object.keys(CHANNELS_DEFAULTS)) {
    if (hasOwn(next, key)) setOrDelete(next, key, withoutDefaults(next[key], CHANNELS_DEFAULTS[key]));
  }
  return next;
}

function separateDisabledAgents(agent) {
  if (hasOwn(agent, 'enabledAgents')) return agent;
  // The stored list used to be the full effective roster and a missing key
  // meant every agent on. Read it against the roster shipped back then, then
  // express the same choices as a delta against the current defaults, so
  // agents that became default-off since (advisor) start off.
  const stored = new Set(disabledAgentIds(agent));
  const previous = new Set(PREVIOUS_DISABLED_AGENT_ROSTER);
  const effective = new Set(DEFAULT_DISABLED_AGENT_ROSTER);
  for (const id of stored) if (!previous.has(id)) effective.add(id);
  for (const id of previous) if (!stored.has(id)) effective.delete(id);
  const next = { ...agent };
  delete next.disabledAgents;
  return { ...next, ...disabledAgentDelta([...effective]) };
}

function separateAgentSection(agent) {
  let next = { ...agent };
  // The live config no longer infers a mode from the workflow, so keep an old
  // explicit non-Solo workflow choice as an explicit mode.
  if (!hasOwn(next, 'orchestrationMode') && legacyWorkflowOrchestrationMode(next.workflow?.active) === 'swarm') {
    next.orchestrationMode = 'swarm';
  }
  if (HISTORICAL_ORCHESTRATION_MODES.includes(next.orchestrationMode)) delete next.orchestrationMode;
  next = separateDisabledAgents(next);
  return stripAgentSectionDefaults(next);
}

// Built-in agents that no longer ship; a stored model route for one is dead
// unless the user keeps an own definition under that id.
const RETIRED_AGENT_IDS = Object.freeze(['debugger', 'explore', 'scheduler-task', 'webhook-handler', 'web-researcher']);

function withoutRetiredAgentRoutes(agents, dataDir) {
  const next = { ...agents };
  for (const id of RETIRED_AGENT_IDS) {
    // Same resolution as the agent loader: agent.json `entry`, non-empty body.
    if (hasOwn(next, id) && !packDefinitionFromDir(join(dataDir, 'agents', id), 'AGENT.md')) delete next[id];
  }
  return next;
}

// Version 2: keys no current code reads, left behind by retired features.
function removeLegacyKeys(root, dataDir) {
  const next = { ...root };
  if (isPlainObject(next.agent)) {
    const agent = { ...next.agent };
    if (isPlainObject(agent.builtins)) {
      agent.builtins = Object.fromEntries(
        Object.entries(agent.builtins).map(([id, entry]) => {
          if (!isPlainObject(entry)) return [id, entry];
          const { firstUseApproval: _retired, ...rest } = entry;
          return [id, rest];
        })
      );
    }
    if (isPlainObject(agent.agents)) agent.agents = withoutRetiredAgentRoutes(agent.agents, dataDir);
    next.agent = agent;
  }
  const channelEntries = next.channels?.access?.channels;
  if (isPlainObject(channelEntries)) {
    const channels = Object.fromEntries(
      Object.entries(channelEntries).map(([id, entry]) => {
        if (!isPlainObject(entry)) return [id, entry];
        const { requireMention: _retired, ...rest } = entry;
        return [id, rest];
      })
    );
    next.channels = { ...next.channels, access: { ...next.channels.access, channels } };
  }
  return next;
}

/**
 * Pure apart from the data-dir lookup: the config root with default-equal
 * values removed, running only the steps newer than the stored marker. Does
 * not set the marker. `stripRouteDefaults` drops shipped presets and
 * maintenance routes (their defaults live with the agent config).
 */
export function separateDefaultsInConfig(
  root,
  { stripRouteDefaults = (agent) => agent, dataDir = resolvePluginData() } = {}
) {
  const from = Number(root?.[DEFAULTS_VERSION_KEY]) || 0;
  let next = { ...(root || {}) };
  if (from < 1) {
    if (isPlainObject(next.agent)) next.agent = separateAgentSection(next.agent);
    if (typeof next.outputStyle === 'string' && next.outputStyle.trim() === DEFAULT_OUTPUT_STYLE) {
      delete next.outputStyle;
    }
    if (isPlainObject(next.channels)) {
      setOrDelete(next, 'channels', withoutDefaults(stripChannelsDefaults(next.channels), {}));
    }
  }
  if (from < 2) {
    next = removeLegacyKeys(next, dataDir);
    if (isPlainObject(next.agent)) next.agent = stripRouteDefaults(stripAgentSectionDefaults(next.agent));
  }
  return next;
}

/**
 * Copy the current config file to
 * `<dataDir>/backups/defaults-separation-<timestamp>[-n]/mixdog-config.json`.
 * The folder is claimed exclusively, so an existing backup is never
 * overwritten. Call it inside the config lock. Returns the backup path, or
 * null when there is no file to copy.
 */
export function backupConfigBeforeDefaultsSeparation({ dataDir = resolvePluginData(), now = new Date() } = {}) {
  const source = configPath();
  if (!existsSync(source)) return null;
  const parent = join(dataDir, 'backups');
  mkdirSync(parent, { recursive: true });
  const stem = `defaults-separation-${now.toISOString().replace(/[:.]/g, '-')}`;
  for (let n = 0; ; n += 1) {
    const dir = join(parent, n ? `${stem}-${n}` : stem);
    try {
      mkdirSync(dir);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    const target = join(dir, 'mixdog-config.json');
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    return target;
  }
}

function needsSeparation(root) {
  return (
    isPlainObject(root) && Object.keys(root).length > 0 && !(Number(root[DEFAULTS_VERSION_KEY]) >= DEFAULTS_VERSION)
  );
}

/** Separation version of the stored file; a missing/empty file is born current. */
export function storedDefaultsVersion() {
  const root = readConfig();
  return needsSeparation(root) ? Number(root[DEFAULTS_VERSION_KEY]) || 0 : DEFAULTS_VERSION;
}

/**
 * Run the one-time separation if the file has not seen this DEFAULTS_VERSION.
 * Returns the backup path when a backup was taken, otherwise null.
 */
export function ensureDefaultsSeparated(options = {}) {
  if (!needsSeparation(readConfig())) return null;
  let backup = null;
  updateConfig((current) => {
    if (!needsSeparation(current)) return current;
    const separated = separateDefaultsInConfig(current, options);
    if (!isDeepStrictEqual(separated, current)) backup = backupConfigBeforeDefaultsSeparation();
    return { ...separated, [DEFAULTS_VERSION_KEY]: DEFAULTS_VERSION };
  });
  return backup;
}
