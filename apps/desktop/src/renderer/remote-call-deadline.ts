const REMOTE_CALL_DEADLINE_MS = 20_000;
// A deadline timer that runs this late was itself held up: the page's main
// thread was blocked when the deadline came due.
const STALLED_DEADLINE_MS = 1_000;
// The blocked thread may be all that holds an answer the socket already
// delivered (it still has to be decrypted, in order, behind other frames).
const STALL_GRACE_MS = 5_000;

/** A method deadline belongs to that call alone. Transport liveness is
 *  checked independently, so a slow operation cannot fail healthy siblings.
 *  Arm it once the request is on the wire: time spent in this page's ordered
 *  send queue is not the peer's latency. A deadline that comes due while the
 *  page is frozen (a phone evaluating Monaco, laying out a large file) waits
 *  a short grace instead of failing a call whose answer is already queued.
 *  Returns the cancel for a settled call. */
export function armRemoteCallDeadline(
  pending: Pick<Map<number, unknown>, 'has' | 'delete'>,
  id: number,
  reject: (error: Error) => void,
  probe: () => void,
  timers: Pick<Window, 'setTimeout' | 'clearTimeout'> = window,
  now: () => number = Date.now
): () => void {
  let timer = 0;
  const arm = (delay: number): void => {
    const dueAt = now() + delay;
    timer = timers.setTimeout(() => {
      if (pending.has(id) && now() - dueAt > STALLED_DEADLINE_MS) {
        arm(STALL_GRACE_MS);
        return;
      }
      if (!pending.delete(id)) return;
      reject(new Error('mixdog remote call timed out.'));
      probe();
    }, delay);
  };
  arm(REMOTE_CALL_DEADLINE_MS);
  return () => timers.clearTimeout(timer);
}
