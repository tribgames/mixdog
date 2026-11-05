// The real worker plus `test.spin`, for the RL G8 driver (native/core/crates/mixdog-exthost/tests/g8.rs):
// the spin call holds one slot with synchronous JS the abort signal cannot interrupt.
import { handlers } from '../methods.mjs';
import { writeFileSync } from 'node:fs';
import { CALL_WINDOW_BYTES } from '../frame.mjs';
import { runWorker } from '../worker-core.mjs';

const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);

runWorker({
  handlers: {
    ...handlers,
    // Exhausts the call's whole window, waits until those bytes are flushed to the core, writes
    // `params.marker`, then asks for one more byte: it blocks there until the consumer takes chunks.
    'test.fill': async ({ params, emit }) => {
      for (let sent = 0; sent < CALL_WINDOW_BYTES; sent += 64 * 1024) await emit(Buffer.alloc(64 * 1024, 7));
      await new Promise((resolve) => writeFrame(Buffer.alloc(0), resolve));
      writeFileSync(params.marker, '');
      await emit(Buffer.alloc(1, 7));
      return { value: null };
    },
    // When the worker produced its result (wall clock, fractional ms), for the core to measure how
    // long the result took to arrive.
    'test.stamp': async () => ({ value: { wroteAtMs: performance.timeOrigin + performance.now() } }),
    'test.spin': async ({ params }) => {
      const end = Date.now() + params.ms;
      while (Date.now() < end);
      return { value: process.pid };
    },
  },
  input: process.stdin,
  write: (bytes) => writeFrame(bytes),
  exit: (code) => process.exit(code),
});
