/**
 * Outgoing-request surrogate sanitizer.
 *
 * A lone UTF-16 surrogate (half of an emoji left by a char-count cut, or
 * carried by tool output / file content) is serialized by JSON.stringify as a
 * `\ud83d` escape that provider APIs reject ("not valid JSON"). This rewrites
 * every string value and every object key to well-formed text (lone surrogate
 * -> U+FFFD) in the request that is about to be sent.
 *
 * Copy-on-write: a request that is already well-formed is returned as the very
 * same object (no allocation, identity kept for caches keyed on messages or
 * tool lists). Only the containers on the path to a bad string are copied; the
 * stored transcript is never mutated. Only arrays and plain objects are
 * walked: Buffer / Uint8Array / ArrayBuffer and any other class instance are
 * binary or opaque payloads and are returned untouched. Own symbol properties
 * (e.g. the provider-native tool prefix count on a tool list) survive a copy.
 */
function copySymbols(target, source) {
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    Object.defineProperty(target, symbol, Object.getOwnPropertyDescriptor(source, symbol));
  }
  return target;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function walk(value, active) {
  if (typeof value === 'string') return value.isWellFormed() ? value : value.toWellFormed();
  if (value === null || typeof value !== 'object' || active.has(value)) return value;
  if (Array.isArray(value)) {
    active.add(value);
    let out = null;
    for (let i = 0; i < value.length; i += 1) {
      const next = walk(value[i], active);
      if (!out && next !== value[i]) out = value.slice();
      if (out) out[i] = next;
    }
    active.delete(value);
    return out ? copySymbols(out, value) : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  active.add(value);
  const keys = Object.keys(value);
  let out = null;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const entry = value[key];
    const nextKey = key.isWellFormed() ? key : key.toWellFormed();
    const nextEntry = walk(entry, active);
    if (!out && (nextKey !== key || nextEntry !== entry)) {
      out = Object.create(proto);
      for (let j = 0; j < i; j += 1) setOwn(out, keys[j], value[keys[j]]);
    }
    if (out) setOwn(out, nextKey, nextEntry);
  }
  active.delete(value);
  return out ? copySymbols(out, value) : value;
}

/** `value` with every string and object key made well-formed; `value` itself when it already is. */
export function sanitizeSurrogates(value) {
  return walk(value, new WeakSet());
}
