/** Serialize accepted work per key without blocking independent keys. */
export function createKeyedSerialQueue() {
  const tails = new Map();
  return function run(key, task) {
    const previous = tails.get(key) ?? Promise.resolve();
    const pending = previous.then(task);
    const settled = pending.then(
      () => {},
      () => {}
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return pending;
  };
}
