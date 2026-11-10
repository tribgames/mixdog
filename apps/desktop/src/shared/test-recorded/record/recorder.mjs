// Recording wrapper: logs every call of a wrapped Node export (args, result or error) to RECORD_FILE. A function that returns a
// service object (an object whose members are functions) is logged as such and its methods are wrapped in turn.
import { appendFileSync } from 'node:fs';
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
const log = (entry) => appendFileSync(process.env.RECORD_FILE, enc(entry) + '\n');
const isService = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((x) => typeof x === 'function');
const instances = new Map();
function record(mod, name, fn, thisArg, liveArgs) {
  const args = JSON.parse(enc(liveArgs)); // as the call was made: the function may mutate what it was given
  let out;
  try { out = fn.apply(thisArg, liveArgs); } catch (error) { log({ mod, name, args, error: { name: error?.name, message: error?.message, code: error?.code } }); throw error; }
  const finish = (v, async) => {
    if (isService(v)) {
      const methods = Object.keys(v).filter((k) => typeof v[k] === 'function');
      log({ mod, name, args, service: methods, async });
      const n = instances.get(name) ?? 0; instances.set(name, n + 1); const base = `${name}#${n}`;
      const wrapped = { ...v };
      for (const k of methods) wrapped[k] = (...a) => record(mod, `${base}.${k}`, v[k], v, a);
      return wrapped;
    }
    log({ mod, name, args, result: v, async });
    return v;
  };
  if (out && typeof out.then === 'function') {
    return out.then((v) => finish(v, true), (error) => { log({ mod, name, args, async: true, error: { name: error?.name, message: error?.message, code: error?.code } }); throw error; });
  }
  return finish(out, false);
}
export function wrap(mod, name, value) {
  if (typeof value !== 'function') { log({ mod, name, constant: value }); return value; }
  if (/^class\s/.test(Function.prototype.toString.call(value))) { log({ mod, name, class: true }); return value; }
  return function (...args) { return record(mod, name, value, this, args); };
}
