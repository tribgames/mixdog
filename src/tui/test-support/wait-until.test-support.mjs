// Deterministic test waits: poll a predicate on the real clock until a
// deadline instead of draining a fixed number of event-loop turns.
import { setTimeout as sleep } from 'node:timers/promises';

// Resolves with the first truthy `read()` value; throws if the deadline passes.
export async function waitUntil(read, { timeoutMs = 5_000, intervalMs = 1, message = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${message}`);
    await sleep(intervalMs);
  }
}

// Waits for work whose completion has no observable signal to settle. `quietMs`
// of real-clock quiet (no change in `read()`) after at least one poll is the
// settle point; bounded by `timeoutMs`.
export async function waitForQuiet(read, { quietMs = 25, timeoutMs = 5_000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  let last = await read();
  let since = performance.now();
  while (performance.now() - since < quietMs) {
    if (performance.now() >= deadline) throw new Error(`waitForQuiet timed out after ${timeoutMs}ms`);
    await sleep(1);
    const next = await read();
    if (next !== last) {
      last = next;
      since = performance.now();
    }
  }
  return last;
}
