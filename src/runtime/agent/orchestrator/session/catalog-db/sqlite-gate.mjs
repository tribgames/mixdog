/**
 * SQLite runtime gate of the session catalog DB. SQLite 3.7.0–3.51.2 can
 * corrupt a WAL database when the WAL is reset while another connection
 * writes (fixed in 3.51.3, backported to 3.50.7). The catalog opens its file
 * only on a library with that fix; any other runtime keeps the JSON catalog.
 */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, minimum) {
  for (let index = 0; index < 3; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

/** True for SQLite ≥ 3.51.3, or 3.50.x ≥ 3.50.7. */
export function sqliteVersionSupported(version) {
  const value = parts(version);
  if (!value) return false;
  if (atLeast(value, [3, 51, 3])) return true;
  return value[0] === 3 && value[1] === 50 && value[2] >= 7;
}

export const SQLITE_REQUIREMENT = '>= 3.51.3 or 3.50.7+';
