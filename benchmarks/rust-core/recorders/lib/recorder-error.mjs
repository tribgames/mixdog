// An error raised by the RECORDER (a wait's deadline, a gate never released, a harness assertion, a stand-in that did not start) is not an outcome of
// Node's code: it is this class, it aborts the whole run with a non-zero exit and writes no fixture. An error thrown by the Node code under test is
// recorded as its outcome (the Node test asserts it). `set.run` rethrows a RecorderError naming set, case and step, and refuses to encode a
// RecorderError anywhere inside an observed value, so no recorder-side catch can turn one into a recorded `threw` / `rejected` / `error`.
export class RecorderError extends Error {
  constructor(message) { super(message); this.name = 'RecorderError'; this.recorderError = true; }
}
export const isRecorderError = (value) => value instanceof RecorderError || (value !== null && typeof value === 'object' && value.recorderError === true);
/** Throws a RecorderError if `value` is one or holds one at any depth (own enumerable properties, arrays, maps, sets, causes). */
export function refuseRecorderErrors(value, where) {
  const seen = new Set();
  const walk = (v, path) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (isRecorderError(v)) throw new RecorderError(`${where}: a recorder error reached an observed value at ${path}: ${v.message}`);
    if (v instanceof Map) { for (const [k, x] of v) walk(x, `${path}.get(${String(k)})`); return; }
    if (v instanceof Set) { for (const x of v) walk(x, `${path}.set`); return; }
    for (const key of Reflect.ownKeys(v)) { let x; try { x = v[key]; } catch { continue; } walk(x, `${path}.${String(key)}`); }
    if (v instanceof Error && v.cause !== undefined) walk(v.cause, `${path}.cause`);
  };
  walk(value, '$');
}
