export function createRemoteTransitionQueue() {
  let tail = Promise.resolve();

  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    settled() {
      return tail;
    },
  };
}
