// Compact immutable session-state deltas shared by the runtime IPC hop and the
// daemon-to-view hop. `itemsAppend` is the protocol's historical field name;
// `from` may identify any first-changed index, so the payload is a suffix
// replacement rather than append-only.

export function diffSessionState(previous, next) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return null;
  const set = {};
  const remove = [];
  let itemsAppend = null;
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] === value) continue;
    if (key === 'items' && Array.isArray(value) && Array.isArray(previous.items)) {
      const sharedLength = Math.min(previous.items.length, value.length);
      let from = 0;
      while (from < sharedLength && previous.items[from] === value[from]) from += 1;
      if (from !== previous.items.length || from !== value.length) {
        itemsAppend = { from, values: value.slice(from) };
      }
      continue;
    }
    set[key] = value;
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) remove.push(key);
  }
  return { set, remove, itemsAppend };
}

export function applySessionStatePatch(previous, patch) {
  const base = previous && typeof previous === 'object' ? previous : {};
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base, ...(patch.set || {}) };
  if (patch.itemsAppend) {
    const items = Array.isArray(base.items) ? base.items : [];
    const from = Math.max(0, Math.min(
      items.length,
      Math.floor(Number(patch.itemsAppend.from) || 0),
    ));
    next.items = items.slice(0, from).concat(
      Array.isArray(patch.itemsAppend.values) ? patch.itemsAppend.values : [],
    );
  }
  for (const key of patch.remove || []) delete next[key];
  return next;
}
