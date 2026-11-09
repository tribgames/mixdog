// Single shared promise-sleep. Timer-holding by design: callers that must not
// keep the process alive during the wait (unref'd timers) keep a local variant.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node supports Atomics.wait on both the main thread and worker threads.
// A failed wait must not silently turn into an event-loop-blocking busy spin.
export function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, Math.max(1, Number(ms) || 1));
}
