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

// Collapse every whitespace run (newlines included) into one space and trim.
export function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
