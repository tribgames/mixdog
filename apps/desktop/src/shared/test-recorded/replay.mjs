// Replays the recorded calls of a Node module: a call is found by its arguments; repeated calls with the same arguments answer in
// the order they were recorded (the last answer repeats). A call that was not recorded is an error, never a guess.
// (Arguments with a measured `timings_ms` are matched by the call's position instead; see below.)
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
  let position = 0;
  return function (...args) {
    if (table.opaque.includes(name)) throw new Error(`${name} returns a live object; it cannot be replayed from a recording`);
    const key = name + '\0' + enc(args);
    // A call whose arguments carry a wall-clock measurement (`timings_ms` differs from run to run) or a per-run temp path (a function
    // listed in the table's `positional`) cannot be found by them: it is the same-numbered call of that function in the recording.
    const nth = position++;
    const answers = table.calls[key] ?? (key.includes('timings_ms') || table.positional?.includes(name.replace(/#\d+/, '')) ? table.calls[(table.order?.[name] ?? [])[nth]] : undefined);
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
