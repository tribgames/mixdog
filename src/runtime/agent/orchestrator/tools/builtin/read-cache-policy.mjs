// The bounded cache validator can certify the whole file only within this
// byte budget. Larger reads must not reuse metadata-only or prefix-only
// content/line-position evidence: equal stats can hide edits past the prefix.
export const READ_PREFIX_HASH_BYTES = 65536;

export function canCacheReadFile(stat) {
  return Number.isFinite(stat?.size) && stat.size >= 0 && stat.size <= READ_PREFIX_HASH_BYTES;
}
