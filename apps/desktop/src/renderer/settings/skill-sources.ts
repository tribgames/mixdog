import { record } from '../record-utils';
import { rows, type RecordValue } from './capability-data';

/** One source's skill from `skillsStatus`: the core lists every source's skill
 *  of a name (own, each plugin, built-in) and says which one is in use. */
export interface SkillSourceRow {
  name: string;
  /** Its disabled-list entry, `<sourceKey>:<name>`. */
  key: string;
  /** `global` (the user's own), `plugin:<id>` or `builtin`. */
  sourceKey: string;
  state: 'inUse' | 'off' | 'hidden';
  /** The source whose skill of this name is used instead. */
  hiddenBy: string;
  /** What turns it off: its own entry (`source`), a bare name entry (`name`),
   *  its required feature being off (`feature`), or its project scope leaving
   *  out the folder the status was read for (`scope`). */
  offBy: string;
  replacesBuiltin: boolean;
  /** Whether its switch can change it: false for a built-in that follows its
   *  feature and for a row off for its feature or its scope. */
  switchable: boolean;
  editable: boolean;
  record: RecordValue;
}

export interface SkillCategory {
  sourceKey: string;
  rows: SkillSourceRow[];
}

export const OWN_SKILLS = 'global';
const BUILTIN_SKILLS = 'builtin';
const PLUGIN_PREFIX = 'plugin:';

export function skillSourceRows(status: unknown): SkillSourceRow[] {
  return rows(record(status), 'skills').map((skill) => ({
    name: String(skill.name || ''),
    key: String(skill.key || ''),
    sourceKey: String(skill.sourceKey || ''),
    state: skill.state === 'off' || skill.state === 'hidden' ? skill.state : 'inUse',
    hiddenBy: String(skill.hiddenBy || ''),
    offBy: String(skill.offBy || ''),
    replacesBuiltin: skill.replacesBuiltin === true,
    switchable: skill.switchable === true,
    editable: skill.editable === true,
    record: skill,
  }));
}

export function pluginIdOf(sourceKey: string): string {
  return sourceKey.startsWith(PLUGIN_PREFIX) ? sourceKey.slice(PLUGIN_PREFIX.length) : '';
}

const isOwnOrPlugin = (row: SkillSourceRow) => row.sourceKey === OWN_SKILLS || Boolean(pluginIdOf(row.sourceKey));

/** A built-in is listed while the disabled list turns it off, or while an own
 *  or plugin skill shares its name: every state the switches reach can be left
 *  again from the panel. */
function isListedBuiltin(row: SkillSourceRow, listedNames: ReadonlySet<string>): boolean {
  if (row.sourceKey !== BUILTIN_SKILLS) return false;
  return (row.state === 'off' && (row.offBy === 'source' || row.offBy === 'name')) || listedNames.has(fold(row.name));
}

/** The user's own category first (kept when empty, for its invitation), then
 *  one per plugin in source order, then the listed built-ins. Other built-in
 *  skills are not listed. */
export function skillCategories(all: readonly SkillSourceRow[]): SkillCategory[] {
  const listedNames = new Set(all.filter(isOwnOrPlugin).map((row) => fold(row.name)));
  const categories = new Map<string, SkillSourceRow[]>([[OWN_SKILLS, []]]);
  for (const row of all) {
    if (!isOwnOrPlugin(row) && !isListedBuiltin(row, listedNames)) continue;
    const list = categories.get(row.sourceKey) ?? [];
    list.push(row);
    categories.set(row.sourceKey, list);
  }
  return [...categories].map(([sourceKey, list]) => ({ sourceKey, rows: list }));
}

const fold = (value: string) => value.toLowerCase();

/** Names (case-folded) that more than one source ships, built-ins counted. */
export function sharedSkillNames(all: readonly SkillSourceRow[]): ReadonlySet<string> {
  const sources = new Map<string, Set<string>>();
  for (const row of all) {
    const name = fold(row.name);
    const seen = sources.get(name) ?? new Set<string>();
    seen.add(row.sourceKey);
    sources.set(name, seen);
  }
  return new Set([...sources].filter(([, seen]) => seen.size > 1).map(([name]) => name));
}

export function isSharedSkill(shared: ReadonlySet<string>, row: SkillSourceRow): boolean {
  return shared.has(fold(row.name));
}

export function isBuiltinSource(sourceKey: string): boolean {
  return sourceKey === BUILTIN_SKILLS;
}
