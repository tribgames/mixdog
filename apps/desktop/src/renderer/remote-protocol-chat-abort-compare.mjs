// How a case the core ran is compared with Node's recordings of it. Nothing is listed by hand:
//  - The run-own paths are COMPUTED: the leaf paths (array positions written `[]`, so `stream[].row.updatedAt` is one path and
//    `stream[].snapshot.items[].id` another) whose values differ between two recordings of Node's own code on the same case. A path
//    that never differed between Node's runs is compared exactly, whatever its key is called.
//  - At a run-own path a value is compared by its type and by its relationships: every string there is renamed by first occurrence
//    (`<s1>`, `<s2>`, …, one table per side and case), so a value that recurs must recur at the same places on both sides and two
//    distinct values never collapse into one; a number keeps only its type.
//  - The ordered stream of what the phone was told is compared whole; Node's own recordings of a case may order it differently
//    (pushes that race), and exactly the orders Node showed are admitted: the core's stream must equal one of them.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf of `value` as [path, leaf]; an empty array or object is a leaf of its own. */
export function leaves(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    if (!value.length) out.push([path, value]);
    value.forEach((v) => leaves(v, `${path}[]`, out));
  } else if (isObj(value)) {
    const keys = Object.keys(value);
    if (!keys.length) out.push([path, value]);
    for (const k of keys) leaves(value[k], `${path}.${k}`, out);
  } else out.push([path, value]);
  return out;
}

/** The paths at which two recordings of the same case differ, position by position: a value that differs, or that one side has
 *  where the other has none. */
export function varyingPaths(a, b) {
  const out = new Set();
  const walk = (x, y, path) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= x.length) leaves(y[i], `${path}[]`).forEach(([p]) => out.add(p));
        else if (i >= y.length) leaves(x[i], `${path}[]`).forEach(([p]) => out.add(p));
        else walk(x[i], y[i], `${path}[]`);
      }
    } else if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!(k in x)) leaves(y[k], `${path}.${k}`).forEach(([p]) => out.add(p));
        else if (!(k in y)) leaves(x[k], `${path}.${k}`).forEach(([p]) => out.add(p));
        else walk(x[k], y[k], `${path}.${k}`);
      }
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      leaves(x, path).forEach(([p]) => out.add(p));
      leaves(y, path).forEach(([p]) => out.add(p));
    }
  };
  walk(a, b, '$');
  return out;
}

/** `value` with every leaf at a run-own path replaced: strings by their first-occurrence number in `names` (shared by everything one
 *  side of one case holds), other values by their type. Everything else is kept as it is. */
export function canonical(value, runOwn, names = new Map(), path = '$') {
  if (Array.isArray(value)) return value.map((v) => canonical(v, runOwn, names, `${path}[]`));
  // Keys are visited in sorted order: the order an object's keys were written in means nothing, and the numbering must not depend on it.
  if (isObj(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v, runOwn, names, `${path}.${k}`)]));
  if (!runOwn.has(path)) return value;
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;
  if (!names.has(value)) names.set(value, `<s${names.size + 1}>`);
  return names.get(value);
}

/** The order of a stream: the kind (and the call, for a reply) of each thing told. */
export const streamOrder = (stream) => (stream ?? []).map((e) => (e.kind === 'reply' ? `reply:${e.method}` : e.kind)).join(',');

/** The run-own paths of a case: those any two of Node's recordings of it differ at. Two streams are aligned position by position only
 *  when they are in the same order; recordings whose streams are in different orders give their run-own paths outside the stream only. */
export function runOwnPaths(recordings) {
  const out = new Set();
  for (let i = 0; i < recordings.length; i++) {
    for (let j = i + 1; j < recordings.length; j++) {
      const [a, b] = [recordings[i], recordings[j]];
      const sameOrder = streamOrder(a.stream) === streamOrder(b.stream);
      const strip = ({ stream: _s, ...rest }) => rest;
      varyingPaths(sameOrder ? a : strip(a), sameOrder ? b : strip(b)).forEach((p) => out.add(p));
    }
  }
  return out;
}
