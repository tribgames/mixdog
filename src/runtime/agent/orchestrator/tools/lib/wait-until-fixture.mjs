// Test support: wait for a real condition on a wall-clock budget. A fixed
// number of event-loop turns is load-dependent (async record writes and
// process-table reads take more turns on a busy machine); elapsed time is not.
// Polls on a short real timer (never a busy loop). The real setTimeout is
// captured at load, before any test enables mock timers, so a mocked clock
// cannot freeze the wait.
import assert from 'node:assert/strict';

const realSetTimeout = setTimeout;
const POLL_MS = 5;
const tick = () => new Promise((resolve) => realSetTimeout(resolve, POLL_MS));

/** Resolves with the first truthy `read()` (sync or async); fails with `what`
 *  once `timeoutMs` has passed without one. */
export async function waitUntil(
  read,
  { timeoutMs = 10_000, what = String(read).replace(/\s+/g, ' ').slice(0, 160) } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(`condition not reached within ${timeoutMs}ms: ${what}`);
    await tick();
  }
}
