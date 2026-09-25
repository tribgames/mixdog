// Coerce any value to a trimmed string; null/undefined become ''. The most
// common input normalizer across the runtime, kept in one place.
export function clean(value) {
  return String(value ?? '').trim();
}

// Strict variant for persisted/record fields: only a string counts, anything
// else becomes '' instead of being stringified.
export function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
