/**
 * Run operations one after another, whatever the outcome of the previous one.
 * `enqueue` resolves with its own operation's result; `idle` resolves (never
 * rejects) once everything enqueued so far has settled.
 */
export function createSerialChain() {
  let chain = Promise.resolve();
  return {
    enqueue(operation) {
      const next = chain.then(operation, operation);
      chain = next.then(
        () => {},
        () => {}
      );
      return next;
    },
    idle: () => chain,
  };
}
