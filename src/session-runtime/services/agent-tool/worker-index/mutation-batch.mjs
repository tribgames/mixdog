// worker-index/mutation-batch.mjs
// Spawn-path writes are batched onto one immediate so a parallel fanout pays a
// single locked rewrite instead of one per worker. `afterFlush` runs once the
// batch's rows are in the store.
export function createMutationBatch(write, afterFlush = () => {}) {
  const pending = [];
  let timer = null;

  function flush() {
    if (timer) {
      clearImmediate(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    write((byKey) => {
      for (const mutator of batch) {
        try {
          mutator(byKey);
        } catch {
          /* one bad row never drops the batch */
        }
      }
    });
    afterFlush();
  }

  function queue(mutator) {
    if (typeof mutator !== 'function') return false;
    pending.push(mutator);
    if (!timer) {
      timer = setImmediate(flush);
      timer.unref?.();
    }
    return true;
  }

  return { queue, flush };
}
