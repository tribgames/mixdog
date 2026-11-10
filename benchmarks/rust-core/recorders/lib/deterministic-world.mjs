// A product process whose world moves only when the script says so: the clock is a number the script advances, the process id is
// fixed, and the random bytes and uuids the product draws come from one hash sequence per request kind (what asks for a size, a
// session id: 16 bytes, is the same code on every run, while background writers' temp names draw other sizes in an order that
// varies). Two recordings of the same script then write the same bytes.
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

/** Installs the world; returns `{ now, advance }`. */
export function installDeterministicWorld({ start, pid }) {
  let clock = start;
  Date.now = () => clock;
  Object.defineProperty(process, 'pid', { value: pid });
  const draws = new Map();
  const draw = (kind, n) => {
    const out = [];
    while (out.length < n) {
      draws.set(kind, (draws.get(kind) ?? 0) + 1);
      out.push(...createHash('sha256').update(`${kind} ${draws.get(kind)}`).digest());
    }
    return Buffer.from(out.slice(0, n));
  };
  const bytes = (n) => draw(`bytes ${n}`, n);
  const uuid = () => {
    const h = draw('uuid', 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  crypto.randomBytes = bytes;
  crypto.randomUUID = uuid;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid, configurable: true });
  syncBuiltinESMExports();
  return {
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
  };
}
