// Key-sorted JSON, used purely as hash input: the same value must serialize to
// the same bytes in every process, so object key order can never leak into a
// prompt-cache key or a trace fingerprint. Kept deliberately minimal — cycles
// and other JSON.stringify refusals throw here and are caught by the hashers.
export function stableHashStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableHashStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableHashStringify(value[key])}`).join(',')}}`;
}
