// Numeric coercion helpers shared across the runtime. Both accept anything
// (env strings, JSON values, undefined) and return an integer or `fallback`.

export function positiveInt(value, fallback = null) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function nonNegativeInt(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
