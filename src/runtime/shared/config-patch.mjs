import { isDeepStrictEqual } from 'node:util';
import { isPlainObject } from './object.mjs';

// Compare normalized configuration snapshots. Arrays are one setting; object
// fields are independent edits. Copy values so a queued save cannot be mutated.
export function diffConfig(before, after, path = []) {
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = Object.hasOwn(before, key) ? before[key] : undefined;
    const next = Object.hasOwn(after, key) ? after[key] : undefined;
    if (isDeepStrictEqual(previous, next)) continue;
    const field = [...path, key];
    if (isPlainObject(next) && (isPlainObject(previous) || (previous === undefined && Object.keys(next).length > 0))) {
      changes.push(...diffConfig(previous || {}, next, field));
    } else if (next === undefined) {
      changes.push({ path: field, remove: true });
    } else {
      changes.push({ path: field, value: structuredClone(next) });
    }
  }
  return changes;
}

function applyField(current, path, change) {
  const next = isPlainObject(current) ? { ...current } : {};
  const [key, ...rest] = path;
  if (change.remove && rest.length && !Object.hasOwn(next, key)) return next;
  // Seed-only field: written where it is missing, never over a stored value.
  if (change.ifAbsent && !rest.length && Object.hasOwn(next, key)) return next;
  if (!rest.length && change.remove) {
    delete next[key];
  } else {
    let value;
    if (rest.length) {
      const current = Object.hasOwn(next, key) ? next[key] : undefined;
      value = applyField(current, rest, change);
    } else {
      value = structuredClone(change.value);
    }
    // Define an own data property, including for literal "__proto__" keys.
    Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return next;
}

const isSet = (value) => value !== undefined && value !== null && value !== '';

function valueAt(source, path) {
  let value = source;
  for (const key of path) {
    if (!isPlainObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** A change with `unlessSet: [path…]` is skipped when the stored value at that
 *  path is already set. It is judged against `current`, the state before the
 *  whole patch, so the changes of one patch that share a guard stand or fall
 *  together whatever their order. */
export function applyConfigPatch(current, changes) {
  return changes.reduce(
    (next, change) =>
      change.unlessSet && isSet(valueAt(current, change.unlessSet)) ? next : applyField(next, change.path, change),
    current
  );
}
