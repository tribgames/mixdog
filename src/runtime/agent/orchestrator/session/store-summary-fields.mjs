/**
 * Field coercion shared by every cold-catalog projection (summary rows, pool
 * rows, transcript reads): the numeric/string normalization and the desktop
 * session-classification shape. Pure, leaf, no IO.
 */
export function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The durable session-id grammar every catalog path accepts. */
export function isStoredSessionId(value) {
  return SESSION_ID_RE.test(value);
}

export function cleanValue(value) {
  return String(value || '').trim();
}

export function desktopSession(value, cwd = '') {
  if (!value || typeof value !== 'object') return null;
  if (value.classification === 'task') return { classification: 'task', projectPath: null };
  if (value.classification !== 'project') return null;
  const projectPath =
    typeof value.projectPath === 'string' && value.projectPath.trim()
      ? value.projectPath.trim()
      : String(cwd || '').trim();
  return projectPath ? { classification: 'project', projectPath } : null;
}
