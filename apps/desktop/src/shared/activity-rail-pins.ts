export const ACTIVITY_RAIL_PINS_EVENT = 'activity-rail-pins-changed';
export const ACTIVITY_RAIL_PIN_IDS = [
  'sessions',
  'agents',
  'schedules',
  'workflows',
  'projects',
  'extensions',
  'skills',
  'source-control',
  'search',
  'webhooks',
  'studio',
] as const;
export const DEFAULT_ACTIVITY_RAIL_PINS = [
  'sessions',
  'agents',
  'schedules',
  'workflows',
  'projects',
  'extensions',
  'skills',
];

export interface ActivityRailPinsState {
  pins: string[];
  /** Assigned inside the shared config write, not by a client clock. */
  revision: number;
}

export function normalizeActivityRailPins(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === 'string' && (ACTIVITY_RAIL_PIN_IDS as readonly string[]).includes(id))
  )
    return null;
  return [...new Set(value)];
}

/** Stored pins: a full state, or a revision alone meaning the default list. */
export function storedPinsState(value: unknown): ActivityRailPinsState | null {
  const full = readActivityRailPinsState(value);
  if (full) return full;
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (Object.hasOwn(stored, 'pins')) return null;
  const revision = stored.revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    ? { pins: [...DEFAULT_ACTIVITY_RAIL_PINS], revision }
    : null;
}

export function readActivityRailPinsState(value: unknown): ActivityRailPinsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const pins = normalizeActivityRailPins(state.pins);
  return pins && typeof state.revision === 'number' && Number.isSafeInteger(state.revision) && state.revision > 0
    ? { pins, revision: state.revision }
    : null;
}
