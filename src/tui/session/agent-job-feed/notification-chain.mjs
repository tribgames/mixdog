// Notification enqueue ordering. Image notifications must read their files
// before they can be enqueued; running each load as an independent detached
// task let a later (or image-free) notification reach the model queue first.
// Everything that has to wait goes through this single FIFO chain, and
// notifications that need no I/O only join it while the chain is busy.

// Hard ceiling for ONE queued task. A never-settling image read (dead FS
// handle, network-backed path) would otherwise hold the FIFO forever and
// stall every later notification.
const NOTIFICATION_TASK_TIMEOUT_MS = 30_000;

function runWithTimeout(task, slot) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      slot.abandoned = true;
      reject(new Error(`notification task timed out after ${NOTIFICATION_TASK_TIMEOUT_MS}ms`));
    }, NOTIFICATION_TASK_TIMEOUT_MS);
    timer.unref?.();
    Promise.resolve()
      .then(() => task(slot))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

export function createNotificationEnqueueChain({ pushNotice }) {
  let chain = Promise.resolve();
  let pendingCount = 0;
  // Abandon marker: a task that is timed out here keeps running (a pending
  // read cannot be cancelled), so it re-checks `slot.abandoned` before
  // enqueueing and can never land out of order behind the notifications that
  // passed it.
  function push(task, onFailure = null) {
    const slot = { abandoned: false };
    pendingCount += 1;
    chain = chain
      .then(() => runWithTimeout(task, slot))
      .catch((error) => {
        slot.abandoned = true;
        // A thrown/timed-out task must not silently DROP its notification:
        // the fallback delivers what it can and the user is told either way.
        try {
          onFailure?.(error);
        } catch {
          /* fallback delivery is best-effort */
        }
        try {
          pushNotice?.(`notification delivery failed: ${error?.message || error}`, 'warn');
        } catch {}
      })
      .then(() => {
        pendingCount -= 1;
      });
  }
  return { push, isBusy: () => pendingCount > 0 };
}
