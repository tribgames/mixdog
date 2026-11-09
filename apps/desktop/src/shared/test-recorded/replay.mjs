// Replays the recorded calls of a Node module: a call is found by ALL of its arguments; repeated calls with the same arguments answer in
// the order they were recorded (the last answer repeats). A call that was not recorded is an error, never a guess.
// Only the per-run values a table names under "normalize" (a measured field, a temp-directory path) are replaced by a placeholder, on the
// recorded and on the live side alike, before the comparison; everything else must be equal.
const dec = (v) => JSON.parse(JSON.stringify(v), (_k, x) => {
  if (x && typeof x === 'object') {
    if ('$undef' in x) return undefined;
    if ('$set' in x) return new Set(x.$set);
    if ('$map' in x) return new Map(x.$map);
    if ('$date' in x) return new Date(x.$date);
    if ('$big' in x) return BigInt(x.$big);
    if ('$num' in x) return Number(x.$num);
    if ('$buf' in x) return Buffer.from(x.$buf);
  }
  return x;
});
const enc = (v) => JSON.stringify(v, (_k, x) => {
  if (x === undefined) return { $undef: 1 };
  if (typeof x === 'function') return { $fn: 1 };
  if (typeof x === 'bigint') return { $big: String(x) };
  if (x instanceof Set) return { $set: [...x] };
  if (x instanceof Map) return { $map: [...x] };
  if (x instanceof Date) return { $date: x.getTime() };
  if (x && x.type === 'Buffer' && Array.isArray(x.data)) return { $buf: x.data };
  if (typeof x === 'number' && !Number.isFinite(x)) return { $num: String(x) };
  return x;
});
/** A class or helper whose instances only carried the test's setup (the usage ledger the test filled): it does nothing here, the recorded
 *  answers of the service built on it stand in for what it held. identity returns its argument. */
export function stub(kind) {
  if (kind === 'identity') return (value) => value;
  return class {
    constructor() {
      return new Proxy(this, { get: (target, key) => (key in target ? target[key] : () => undefined) });
    }
  };
}

/** Replaces the per-run parts of `value` that the call's rules name: `{field}` (the value of every property of that name, also inside
 *  JSON text) and `{pattern, flags, placeholder}` (every match in a string). */
export function normalizeArgs(value, rules) {
  if (!rules?.length) return value;
  const patterns = rules.filter((rule) => rule.pattern);
  const fields = new Set(rules.filter((rule) => rule.field).map((rule) => rule.field));
  const walk = (node) => {
    if (typeof node === 'string') {
      let text = node;
      for (const rule of patterns) text = text.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.placeholder);
      if (fields.size && /^\s*[{[]/.test(text)) {
        try {
          return JSON.stringify(walk(JSON.parse(text)));
        } catch {
          return text;
        }
      }
      return text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, fields.has(key) ? `<${key}>` : walk(child)]));
    }
    return node;
  };
  return walk(value);
}

/** The key a call is found by: its function and its (normalized) arguments. */
export function callKey(table, name, args) {
  const rules = table.normalize?.[name.replace(/#\d+/, '')];
  return name + '\0' + JSON.stringify(normalizeArgs(JSON.parse(enc(args)), rules));
}

export function replay(table, name) {
  if (Object.hasOwn(table.constants, name)) return dec(table.constants[name]);
  if (table.stubs?.[name]) return stub(table.stubs[name]);
  const service = table.services?.[name];
  if (service) {
    // Each call builds a new service, as the recorded one did: the n-th answers with what the n-th recorded service answered.
    let built = 0;
    const last = Math.max(0, (table.instances?.[name] ?? 1) - 1);
    return () => {
      const base = `${name}#${Math.min(built++, last)}`;
      return Object.fromEntries(service.map((method) => [method, replay(table, `${base}.${method}`)]));
    };
  }
  const seen = new Map();
  return function (...args) {
    if (table.opaque.includes(name)) throw new Error(`${name} returns a live object; it cannot be replayed from a recording`);
    const key = callKey(table, name, args);
    const answers = table.calls[key];
    if (!answers) throw new Error(`${name}(${enc(args)}) was not recorded from Node`);
    const at = Math.min(seen.get(key) ?? 0, answers.length - 1);
    seen.set(key, at + 1);
    const answer = answers[at];
    if (answer.error) {
      const failure = Object.assign(new Error(answer.error.message), { name: answer.error.name, code: answer.error.code });
      if (answer.async) return Promise.reject(failure);
      throw failure;
    }
    const value = dec(answer.result);
    return answer.async ? Promise.resolve(value) : value;
  };
}
