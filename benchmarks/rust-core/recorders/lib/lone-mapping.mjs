// The one mapping decisions.md "Lone UTF-16 surrogates in client strings" allows between Node's value and the core's: where Node
// holds an unpaired UTF-16 surrogate, the core holds U+FFFD. A set's manifest lists every place it applies (`mapping.at`); `mapAt`
// applies it there and nowhere else, so a lone unit at any other place, or a listed place that holds none, fails the comparison.

export const LONE_MAPPING = {
  decision: 'decisions.md "Lone UTF-16 surrogates in client strings"',
  how: 'each unpaired UTF-16 surrogate of the string, or the object key, at a listed JSON pointer becomes U+FFFD (String.prototype.toWellFormed); nothing else changes',
  helper: 'benchmarks/rust-core/recorders/lib/lone-mapping.mjs mapAt',
};

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const escape = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (part) => part.replace(/~1/g, '/').replace(/~0/g, '~');

/** Every place of `value` holding a lone surrogate, in document order: `{ pointer }` for a string, `{ pointer, key: true }` for
 *  an object key (the pointer ends with the key as Node holds it). */
export function lonePlaces(value, pointer = '', out = []) {
  if (typeof value === 'string') {
    if (LONE.test(value)) out.push({ pointer });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => lonePlaces(item, `${pointer}/${index}`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const at = `${pointer}/${escape(key)}`;
      if (LONE.test(key)) out.push({ pointer: at, key: true });
      lonePlaces(item, at, out);
    }
  }
  return out;
}

/** `value` (a copy) with the mapping applied at exactly `places` (lonePlaces' form). A place that is not there or holds no lone
 *  surrogate, and two keys of one object that become one, throw. */
export function mapAt(value, places) {
  const out = structuredClone(value);
  const depth = (place) => place.pointer.split('/').length;
  // Strings first, by Node's own keys; then keys, deepest first, so every pointer still names Node's key when it is used.
  const ordered = [...places.filter((place) => !place.key), ...places.filter((place) => place.key).sort((a, b) => depth(b) - depth(a))];
  for (const place of ordered) {
    const parts = place.pointer.split('/').slice(1).map(unescape);
    const last = parts.pop();
    let parent = out;
    for (const part of parts) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error(`the listed place ${JSON.stringify(place)} is not there`);
      parent = parent[part];
    }
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, last)) throw new Error(`the listed place ${JSON.stringify(place)} is not there`);
    if (place.key) {
      if (!LONE.test(last)) throw new Error(`the listed key ${JSON.stringify(place)} holds no lone surrogate`);
      const read = last.toWellFormed();
      if (Object.hasOwn(parent, read)) throw new Error(`the listed key ${JSON.stringify(place)} becomes a key its object already has`);
      const entries = Object.entries(parent).map(([key, item]) => [key === last ? read : key, item]);
      for (const key of Object.keys(parent)) delete parent[key];
      for (const [key, item] of entries) parent[key] = item;
    } else {
      if (typeof parent[last] !== 'string' || !LONE.test(parent[last])) throw new Error(`the listed place ${JSON.stringify(place)} holds no lone surrogate`);
      parent[last] = parent[last].toWellFormed();
    }
  }
  return out;
}
