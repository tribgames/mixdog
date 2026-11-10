/** Share equal immutable strings in a parsed JSON tree. Containers stay
 * independent, and the pool is local to one snapshot rather than global. */
export function shareJsonStrings(value, strings = new Map()) {
  const intern = (text) => {
    const shared = strings.get(text);
    if (shared !== undefined) return shared;
    strings.set(text, text);
    return text;
  };
  if (typeof value === 'string') return intern(value);
  const pending = value && typeof value === 'object' ? [value] : [];
  while (pending.length) {
    const record = pending.pop();
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child === 'string') record[key] = intern(child);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return value;
}

/** Preserve JSON.stringify/parse semantics (including toJSON) while sharing
 * the original immutable text instead of retaining a second copy of it. */
export function cloneJsonWithSharedStrings(value) {
  const strings = new Map();
  const serialized = JSON.stringify(value, (_key, child) => {
    if (typeof child === 'string' && !strings.has(child)) strings.set(child, child);
    return child;
  });
  return shareJsonStrings(JSON.parse(serialized), strings);
}
