// Generated ids are a recorded input, not a per-run value: crypto.randomUUID (the node:crypto export and the global one) answers a counter,
// 00000000-0000-4000-8000-<12 digit counter>, from the first call of the run. The modules under test read it through either route.
import crypto, { webcrypto } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

export function scriptUuids() {
  let n = 0;
  const next = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;
  crypto.randomUUID = next;
  Object.defineProperty(webcrypto, 'randomUUID', { value: next, configurable: true, writable: true });
  if (globalThis.crypto !== webcrypto) Object.defineProperty(globalThis.crypto, 'randomUUID', { value: next, configurable: true, writable: true });
  syncBuiltinESMExports();
  return { source: 'crypto.randomUUID answers 00000000-0000-4000-8000-<counter, 12 digits> from 1, in call order', reset() { n = 0; } };
}
