// Coerce any value to a trimmed string; null/undefined become ''. The most
// common input normalizer across the runtime, kept in one place.
export function clean(value) {
  return String(value ?? '').trim();
}
