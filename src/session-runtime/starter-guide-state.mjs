// The desktop "Getting started" guide state, kept in the config beside the
// onboarding flags (`onboarding.starterGuide`) so it outlives the renderer's
// localStorage. The desktop IPC gate (ipc-validation.ts) mirrors the schema.
export const STARTER_GUIDE_STEPS = Object.freeze(['provider', 'project', 'workflow', 'extensions', 'remote']);
const STARTER_GUIDE_KEYS = new Set(['closed', 'welcomed', 'visited']);

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The guide state of a user who has not answered it yet. */
export function freshStarterGuide() {
  return { closed: false, welcomed: false, visited: [] };
}

/** The stored copy, read tolerantly; null when there is none. */
export function storedStarterGuide(value) {
  if (!plainObject(value)) return null;
  const visited = Array.isArray(value.visited) ? value.visited : [];
  return {
    closed: value.closed === true,
    welcomed: value.welcomed === true,
    visited: STARTER_GUIDE_STEPS.filter((step) => visited.includes(step)),
  };
}

/** A save request, read strictly: anything off-schema is rejected, never coerced. */
export function requiredStarterGuideState(value) {
  if (!plainObject(value)) throw new TypeError('starter guide state must be an object.');
  for (const key of Object.keys(value)) {
    if (!STARTER_GUIDE_KEYS.has(key)) throw new TypeError(`starter guide state has an unknown field: ${key}.`);
  }
  if (typeof value.closed !== 'boolean' || typeof value.welcomed !== 'boolean') {
    throw new TypeError('starter guide closed and welcomed must be booleans.');
  }
  if (
    !Array.isArray(value.visited) ||
    value.visited.length > STARTER_GUIDE_STEPS.length * 2 ||
    value.visited.some((step) => !STARTER_GUIDE_STEPS.includes(step))
  ) {
    throw new TypeError('starter guide visited must list known steps.');
  }
  return storedStarterGuide(value);
}

/** Every field only moves forward: a stale save can add, never undo. */
export function mergeStarterGuide(stored, next) {
  const base = stored || freshStarterGuide();
  return {
    closed: base.closed || next.closed,
    welcomed: base.welcomed || next.welcomed,
    visited: STARTER_GUIDE_STEPS.filter((step) => base.visited.includes(step) || next.visited.includes(step)),
  };
}

/**
 * The onboarding section after a completion: a first completion starts the
 * guide fresh, so an absent copy afterwards means a profile onboarded before
 * the guide was persisted here.
 */
export function withStarterGuideOnCompletion(previous, onboarding) {
  if (previous?.completed === true || storedStarterGuide(previous?.starterGuide)) return onboarding;
  return { ...onboarding, starterGuide: freshStarterGuide() };
}
