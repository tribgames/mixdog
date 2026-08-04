// One background route preparation can be associated with the currently
// resumed session. Resume/navigation reads do not wait for it; the next real
// turn does. Clearing replaces the visible gate without attempting to cancel
// provider initialization that may already be shared elsewhere.
export function createRoutePreparationGate({ onError } = {}) {
  let pending = Promise.resolve();

  return {
    clear() {
      pending = Promise.resolve();
    },
    start(task) {
      const operation = Promise.resolve().then(task);
      pending = operation;
      // Keep the original rejecting promise for waiters while still marking a
      // background failure as observed until a submit reaches the same gate.
      void operation.catch((error) => onError?.(error));
      return operation;
    },
    wait() {
      return pending;
    },
  };
}
