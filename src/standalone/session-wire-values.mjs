const MAX_CLONE_DEPTH = 24;

/** JSON-safe projection of a session snapshot. Functions, symbols, and
 *  undefined never survive a transport hop; dropping them here (instead of at
 *  JSON.stringify time) keeps object identity stable for the receiver and
 *  makes cycles impossible rather than fatal. */
export function sanitizeForWire(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return Number(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (type !== 'object') return undefined;
  if (depth >= MAX_CLONE_DEPTH) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const entry of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        out.push(cloned === undefined ? null : cloned);
      }
      return out;
    }
    if (value instanceof Map) {
      const out = {};
      for (const [key, entry] of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        if (cloned !== undefined) out[String(key)] = cloned;
      }
      return out;
    }
    if (value instanceof Set) {
      const out = [];
      for (const entry of value) {
        const cloned = sanitizeForWire(entry, depth + 1, seen);
        if (cloned !== undefined) out.push(cloned);
      }
      return out;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = sanitizeForWire(entry, depth + 1, seen);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
