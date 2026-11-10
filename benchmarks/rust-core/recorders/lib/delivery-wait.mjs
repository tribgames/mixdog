// Waiting for Node's `noteTurnReviewChanged` deliveries to reach their listeners (turn-boundary-signal.mjs). Node gives the
// signal no completion event of its own, so the event is a probe listener: registered when the wait starts it is the last
// listener, and the continuation of the promise it resolves runs after the whole delivery that called it. The only question put
// to the registry is whether a delivery is queued at all (`reviewQueued`); nothing waits by yielding in a loop.

/** How long one queued delivery may take to reach the listeners. */
export const DELIVERY_DEADLINE_MS = 10_000;
/** How many deliveries one wait follows: a listener that signals again after every delivery never lets the queue empty. */
export const MAX_DELIVERIES = 1_000;

const registry = () => globalThis[Symbol.for('mixdog.turnBoundarySignal.v1')];

function oneDelivery(boundary, what, deadlineMs) {
  return new Promise((resolve, reject) => {
    const off = boundary.onTurnReviewChanged(() => {
      off();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`${what}: the queued review delivery did not reach its listeners within ${deadlineMs} ms`));
    }, deadlineMs);
  });
}

/** Resolves once no delivery is queued, after following each one that is. */
export async function drainDeliveries(boundary, what, { deadlineMs = DELIVERY_DEADLINE_MS, maxDeliveries = MAX_DELIVERIES } = {}) {
  for (let followed = 0; registry()?.reviewQueued; followed += 1) {
    if (followed >= maxDeliveries) {
      throw new Error(`${what}: a review delivery is still queued after following ${maxDeliveries} of them; a listener signals again after every delivery`);
    }
    await oneDelivery(boundary, what, deadlineMs);
  }
}
