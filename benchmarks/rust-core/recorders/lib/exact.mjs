// Exact, JSON-safe form of a JavaScript value, for recordings a Rust replay must equal.
//
// JSON.stringify silently changes values: NaN and the infinities become null, -0 becomes 0, an undefined
// property disappears, undefined in an array becomes null, a Date becomes a string, a Map or Set becomes {},
// a BigInt throws and an Error becomes {}. A recording made that way holds an input or a result Node never had.
// `exact` keeps every value: what JSON cannot hold becomes a tagged object `{ "$exact": <kind>, ... }`, and a
// value it has no exact form for throws with the path to it, so nothing is lost silently.
//
// Tags: undefined | NaN | Infinity | -Infinity | -0 | hole (an empty array slot) | bigint {value} |
//       date {ms, iso} (ms null for an invalid date) | bytes {type, base64} | map {entries} | set {values} |
//       error {name, message, stack: never, code?, cause?, props} | object {entries} (an object that has its
//       own "$exact" key, a "__proto__" key, or a key that is not well-formed UTF-16) |
//       utf16 {units} (a string holding a lone surrogate, as its UTF-16 code units: JSON text that UTF-8
//       readers accept cannot hold one).
// Plain objects keep their keys in insertion order; an object of any other class throws unless `classes`
// gives a function for its constructor name that returns the plain value to record in its place.
//
// A manifest that uses this names it once: "values": "exact (benchmarks/rust-core/recorders/lib/exact.mjs)".

const TAG = '$exact';
const tag = (kind, rest = {}) => ({ [TAG]: kind, ...rest });

export function exact(value, options = {}) {
  const classes = options.classes ?? {};
  const seen = new Set();
  const walk = (v, path) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.isWellFormed() ? v : tag('utf16', { units: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) });
    if (v === undefined) return tag('undefined');
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return tag('NaN');
      if (v === Infinity) return tag('Infinity');
      if (v === -Infinity) return tag('-Infinity');
      if (Object.is(v, -0)) return tag('-0');
      return v;
    }
    if (typeof v === 'bigint') return tag('bigint', { value: v.toString() });
    if (typeof v !== 'object') throw new TypeError(`exact: a ${typeof v} at ${path} has no exact form`);
    if (seen.has(v)) throw new TypeError(`exact: a cycle at ${path}`);
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length; i += 1) out.push(i in v ? walk(v[i], `${path}[${i}]`) : tag('hole'));
        return out;
      }
      if (v instanceof Date) {
        const ms = v.getTime();
        return tag('date', Number.isNaN(ms) ? { ms: null, iso: null } : { ms, iso: v.toISOString() });
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        const bytes = v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        return tag('bytes', { type: v.constructor.name, base64: bytes.toString('base64') });
      }
      if (v instanceof Map) return tag('map', { entries: [...v].map(([k, x], i) => [walk(k, `${path}<key ${i}>`), walk(x, `${path}<value ${i}>`)]) });
      if (v instanceof Set) return tag('set', { values: [...v].map((x, i) => walk(x, `${path}<${i}>`)) });
      if (v instanceof Error) {
        const props = {};
        for (const key of Object.keys(v)) if (key !== 'code' && key !== 'cause') props[key] = walk(v[key], `${path}.${key}`);
        const out = { name: v.name, message: v.message };
        if ('code' in v) out.code = walk(v.code, `${path}.code`);
        if ('cause' in v) out.cause = walk(v.cause, `${path}.cause`);
        return tag('error', { ...out, props });
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        const name = v.constructor?.name ?? '(no constructor)';
        if (typeof classes[name] !== 'function') throw new TypeError(`exact: a ${name} at ${path} has no exact form (give classes.${name})`);
        return walk(classes[name](v), path);
      }
      const keys = Object.keys(v);
      const entries = keys.map((key) => [key, walk(v[key], `${path}.${key}`)]);
      if (keys.some((key) => !key.isWellFormed())) return tag('object', { entries: entries.map(([key, x]) => [walk(key, path), x]) });
      if (keys.includes(TAG) || keys.includes('__proto__')) return tag('object', { entries });
      return Object.fromEntries(entries);
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, options.path ?? '$');
}

// The value `exact` was given, from its encoded form (an error comes back as an Error with the same name,
// message, code, cause and own properties; a class given through `classes` comes back as the plain value).
export function fromExact(encoded) {
  if (encoded === null || typeof encoded !== 'object') return encoded;
  if (Array.isArray(encoded)) {
    const out = new Array(encoded.length);
    encoded.forEach((x, i) => {
      if (!(x !== null && typeof x === 'object' && x[TAG] === 'hole')) out[i] = fromExact(x);
    });
    return out;
  }
  if (!Object.hasOwn(encoded, TAG)) return Object.fromEntries(Object.entries(encoded).map(([k, x]) => [k, fromExact(x)]));
  switch (encoded[TAG]) {
    case 'undefined': return undefined;
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    case '-Infinity': return -Infinity;
    case '-0': return -0;
    case 'bigint': return BigInt(encoded.value);
    case 'date': return new Date(encoded.ms === null ? NaN : encoded.ms);
    case 'bytes': {
      const bytes = Buffer.from(encoded.base64, 'base64');
      if (encoded.type === 'Buffer') return bytes;
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return encoded.type === 'ArrayBuffer' ? copy : new globalThis[encoded.type](copy);
    }
    case 'map': return new Map(encoded.entries.map(([k, x]) => [fromExact(k), fromExact(x)]));
    case 'set': return new Set(encoded.values.map(fromExact));
    case 'error': {
      const error = new Error(encoded.message);
      Object.defineProperty(error, 'name', { value: encoded.name, writable: true, configurable: true, enumerable: false });
      if ('code' in encoded) error.code = fromExact(encoded.code);
      if ('cause' in encoded) error.cause = fromExact(encoded.cause);
      for (const [key, x] of Object.entries(encoded.props)) error[key] = fromExact(x);
      return error;
    }
    case 'utf16': return String.fromCharCode(...encoded.units);
    case 'object': {
      const out = {};
      for (const [key, x] of encoded.entries) Object.defineProperty(out, fromExact(key), { value: fromExact(x), writable: true, configurable: true, enumerable: true });
      return out;
    }
    default: throw new TypeError(`fromExact: unknown tag ${JSON.stringify(encoded[TAG])}`);
  }
}

// The arguments of a call, exactly: an omitted argument is absent from the list, an explicit undefined is tagged.
export const exactArgs = (args, options) => exact([...args], options);
