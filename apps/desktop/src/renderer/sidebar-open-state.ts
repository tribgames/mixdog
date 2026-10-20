/** Persisted open/collapsed state of sidebar sections, project folders and
 *  automation groups. Each map stores only explicit choices (the resolved value
 *  of a toggle); an absent key falls back to its default. */
export type OpenMap = Readonly<Record<string, boolean>>;

export const SECTION_OPEN_KEY = 'mixdog:session-sidebar-section-open';
export const PROJECT_OPEN_KEY = 'mixdog:session-sidebar-project-open';
export const AUTOMATION_OPEN_KEY = 'mixdog:session-sidebar-automation-open';
/** Fork groups, keyed by the original session id; absent = expanded. */
export const FORK_OPEN_KEY = 'mixdog:session-sidebar-fork-open';
/** Pre-map storage: ids of the expanded folders (everything else was closed). */
export const LEGACY_EXPANDED_PROJECTS_KEY = 'mixdog:session-sidebar-expanded-projects';

/** Sections open by default except Archived. */
export const SECTION_OPEN_DEFAULTS: Readonly<Record<string, boolean>> = {
  agents: true,
  projects: true,
  favorites: true,
  recent: true,
  automations: true,
  archived: false,
};

export type OpenStateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function isOpen(map: OpenMap, key: string, fallback = true): boolean {
  return Object.hasOwn(map, key) ? map[key] : fallback;
}

/** Same map when the resolved value already matches. */
export function withOpen(map: OpenMap, key: string, value: boolean, fallback = true): OpenMap {
  return isOpen(map, key, fallback) === value ? map : { ...map, [key]: value };
}

export function toggleOpen(map: OpenMap, key: string, fallback = true): OpenMap {
  return { ...map, [key]: !isOpen(map, key, fallback) };
}

export function normalizeOpenMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, flag] of Object.entries(value)) {
    if (key && typeof flag === 'boolean') out[key] = flag;
  }
  return out;
}

function parseJson(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readOpenMap(storage: OpenStateStorage, storageKey: string): Record<string, boolean> {
  try {
    return normalizeOpenMap(parseJson(storage.getItem(storageKey)));
  } catch {
    return {};
  }
}

export function writeOpenMap(storage: OpenStateStorage, storageKey: string, map: OpenMap) {
  try {
    storage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // The live state still applies when persistent storage is unavailable.
  }
}

/** Project folder map. When the new key is absent, folders the old
 *  expanded-only set listed are seeded open and the old key is removed. */
export function readProjectOpenMap(storage: OpenStateStorage): Record<string, boolean> {
  try {
    if (storage.getItem(PROJECT_OPEN_KEY) !== null) return readOpenMap(storage, PROJECT_OPEN_KEY);
    const legacy = storage.getItem(LEGACY_EXPANDED_PROJECTS_KEY);
    if (legacy === null) return {};
    const parsed = parseJson(legacy);
    const map: Record<string, boolean> = {};
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string' && id !== '') map[id] = true;
    }
    writeOpenMap(storage, PROJECT_OPEN_KEY, map);
    storage.removeItem(LEGACY_EXPANDED_PROJECTS_KEY);
    return map;
  } catch {
    return {};
  }
}

/** Keys of an open map whose explicit value is closed. */
export function closedKeys(map: OpenMap): Set<string> {
  return new Set(Object.keys(map).filter((key) => map[key] === false));
}
