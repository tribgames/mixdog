/**
 * Test helper: wait until `ready()` is truthy, polling once per event-loop turn
 * (or every `pollMs` real milliseconds for I/O such as file watchers), and fail
 * with `label` after `timeoutMs` so a regression fails fast instead of running
 * into the file timeout. The deadline uses hrtime, which fake timers and a
 * mocked Date or performance.now leave alone.
 */
export async function waitUntil(ready, label, { timeoutMs = 5_000, pollMs = 0 } = {}) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (!ready()) {
    if (process.hrtime.bigint() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => (pollMs > 0 ? setTimeout(resolve, pollMs) : setImmediate(resolve)));
  }
}
