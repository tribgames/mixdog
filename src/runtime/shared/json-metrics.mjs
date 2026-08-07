import { createHash } from 'node:crypto';

function escapedStringBytes(value) {
  const text = String(value);
  let bytes = Buffer.byteLength(text, 'utf8') + 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c
      || code === 0x0a || code === 0x0d || code === 0x09) bytes += 1;
    else if (code < 0x20) bytes += 5;
  }
  return bytes;
}

export function estimateJsonBytes(value, seen = new Set()) {
  if (value === null) return 4;
  if (typeof value === 'string') return escapedStringBytes(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'bigint') return String(value).length;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let bytes = 2;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) bytes += 1;
        bytes += estimateJsonBytes(value[index], seen);
      }
      return bytes;
    }
    let bytes = 2;
    let first = true;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      if (!first) bytes += 1;
      first = false;
      bytes += escapedStringBytes(key) + 1 + estimateJsonBytes(entry, seen);
    }
    return bytes;
  } finally {
    seen.delete(value);
  }
}

export function hashStructuredValue(value, {
  algorithm = 'sha1',
  maxStringChars = Infinity,
} = {}) {
  const hash = createHash(algorithm);
  let remaining = Number.isFinite(maxStringChars) ? Math.max(0, maxStringChars) : Infinity;
  const seen = new Set();
  const walk = (entry) => {
    if (remaining <= 0) return;
    if (entry === null) { hash.update('n;'); return; }
    const type = typeof entry;
    if (type === 'string') {
      const slice = remaining === Infinity ? entry : entry.slice(0, remaining);
      hash.update('s:').update(slice).update(';');
      if (remaining !== Infinity) remaining -= slice.length;
      return;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
      hash.update(`${type[0]}:${String(entry)};`);
      return;
    }
    if (type === 'undefined' || type === 'function' || type === 'symbol') {
      hash.update('u;');
      return;
    }
    if (seen.has(entry)) { hash.update('c;'); return; }
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        hash.update('[');
        for (const item of entry) walk(item);
        hash.update(']');
        return;
      }
      hash.update('{');
      for (const [key, item] of Object.entries(entry)) {
        hash.update('k:').update(key).update(';');
        walk(item);
        if (remaining <= 0) break;
      }
      hash.update('}');
    } finally {
      seen.delete(entry);
    }
  };
  walk(value);
  return hash.digest('hex');
}
