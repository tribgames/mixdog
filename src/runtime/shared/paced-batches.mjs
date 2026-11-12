// Restart recovery in bounded batches: the items come back in their order,
// `batchSize` at a time, and the event loop turns once between batches, so a
// restart with twenty agents is never one uninterrupted run that holds the main
// thread (and the supervisor's ping, answered by it). A batch's tasks run
// concurrently, as the whole list did before; a rejecting task is the caller's
// to handle inside `task`.
export const RECOVERY_BATCH_SIZE = 4;

export async function runInPacedBatches(items, task, { batchSize = RECOVERY_BATCH_SIZE } = {}) {
  const list = [...items];
  for (let start = 0; start < list.length; start += batchSize) {
    if (start > 0) await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(list.slice(start, start + batchSize).map(task));
  }
}
