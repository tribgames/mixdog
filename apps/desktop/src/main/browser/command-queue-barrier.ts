/** How one command waits for the work ahead of it on its queue key, and how
 *  its own completion is recorded for the commands after it. */
import { browserCancellation } from './settle';

export interface QueueLedger {
  /** One promise chain per queue key. */
  chains: Map<string, Promise<unknown>>;
  /** Reads in flight per queue key, which a write must outlast. */
  pendingReads: Map<string, Set<Promise<unknown>>>;
}

export function waitForBarrier(barrier: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(browserCancellation(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(browserCancellation(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void barrier.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

/** Reads overlap each other; a write also outlasts the reads already in flight. */
export function queueBarrier(
  previous: Promise<unknown> | undefined,
  reads: Set<Promise<unknown>> | undefined,
  readOnly: boolean
): Promise<unknown> {
  const chain = previous || Promise.resolve();
  return readOnly || !reads?.size
    ? chain.catch(() => undefined)
    : Promise.allSettled([chain, ...reads]).then(() => undefined);
}

export function trackQueueTail(
  ledger: QueueLedger,
  key: string,
  readOnly: boolean,
  reads: Set<Promise<unknown>> | undefined,
  barrier: Promise<unknown>,
  tail: Promise<void>
): void {
  if (readOnly) {
    const group = reads || new Set<Promise<unknown>>();
    group.add(tail);
    ledger.pendingReads.set(key, group);
    void tail.then(() => {
      group.delete(tail);
      if (!group.size && ledger.pendingReads.get(key) === group) ledger.pendingReads.delete(key);
    });
    return;
  }
  // A caller may cancel while still behind an older mutation. Its own
  // response can reject immediately, but the queue key must continue to
  // represent that older mutation until the barrier actually settles.
  const queueTail = Promise.allSettled([barrier, tail]).then(() => undefined);
  ledger.chains.set(key, queueTail);
  void queueTail.then(() => {
    if (ledger.chains.get(key) === queueTail) ledger.chains.delete(key);
  });
}
