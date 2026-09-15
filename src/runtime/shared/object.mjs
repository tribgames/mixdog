// Object helpers shared across the runtime.

// Null-safe own-property probe: `Object.hasOwn` throws on null/undefined, and
// validators routinely probe optional payloads before shape checks.
export function hasOwn(value, key) {
  return value != null && Object.hasOwn(value, key);
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
