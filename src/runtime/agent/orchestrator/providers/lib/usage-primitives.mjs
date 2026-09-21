// Shared numeric/string primitives for provider usage-accounting modules.
//
// NOTE ON `num`: api-usage.mjs and oauth-usage.mjs use the guarded variant
// below (treats null/undefined/'' as the fallback before Number()).
// opencode-go-usage.mjs uses an *unguarded* variant (Number('') === 0), which
// is observably different, so it keeps its own local `num` and is NOT wired to
// this module.

export function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

export function cleanString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}
