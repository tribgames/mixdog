function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

export function providerInitCacheKey(value) {
  try {
    return JSON.stringify(sortKeysDeep(value));
  } catch {
    return `uncacheable:${Date.now()}:${Math.random()}`;
  }
}
