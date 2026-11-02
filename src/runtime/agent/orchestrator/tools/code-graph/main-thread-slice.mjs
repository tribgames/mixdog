// Cooperative time slicing for graph-wide work that has to run on the daemon
// main thread: a loop checks `expired()` between items and awaits `yield()`
// once the budget is spent, so no single stretch holds the event loop longer
// than one budget plus one item.
import { performance } from 'node:perf_hooks';

export const MAIN_THREAD_SLICE_MS = 8;

export function _mainThreadSlice(budgetMs = MAIN_THREAD_SLICE_MS) {
  let deadline = performance.now() + budgetMs;
  return {
    expired: () => performance.now() >= deadline,
    async yield() {
      await new Promise((resolve) => setImmediate(resolve));
      deadline = performance.now() + budgetMs;
    },
  };
}
