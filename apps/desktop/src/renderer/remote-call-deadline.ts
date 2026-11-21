const REMOTE_CALL_DEADLINE_MS = 20_000;
// A deadline timer that runs this late was itself held up: the page's main
// thread was blocked when the deadline came due.
const STALLED_DEADLINE_MS = 1_000;
// The blocked thread may be all that holds an answer the socket already
// delivered (it still has to be decrypted, in order, behind other frames).
const STALL_GRACE_MS = 5_000;
// Longer than the wake probe's 2.5 s pong allowance: a dead leg closes first and fails the call as interrupted.
const PROBE_SETTLE_MS = 5_000;
const REMOTE_CALL_TIMEOUT_MESSAGE = 'mixdog remote call timed out.';

/** A call that got no answer within its deadline; the connection is probed
 *  and a lost one reconnects, so the caller may repeat it. */
export function isRemoteCallTimeoutError(error: unknown): boolean {
  return (error as { message?: unknown } | null)?.message === REMOTE_CALL_TIMEOUT_MESSAGE;
}

/** Per-call deadline, armed once the request is on the wire. A deadline that falls due while the page is frozen waits STALL_GRACE_MS; an overdue call probes the leg first and times out only if the leg survives PROBE_SETTLE_MS. Returns the cancel for a settled call. */
export function armRemoteCallDeadline(
  pending: Pick<Map<number, unknown>, 'has' | 'delete'>,
  id: number,
  reject: (error: Error) => void,
  probe: () => void,
  timers: Pick<Window, 'setTimeout' | 'clearTimeout'> = window,
  now: () => number = Date.now
): () => void {
  let timer = 0;
  let probed = false;
  const arm = (delay: number): void => {
    const dueAt = now() + delay;
    timer = timers.setTimeout(() => {
      if (pending.has(id) && now() - dueAt > STALLED_DEADLINE_MS) {
        arm(STALL_GRACE_MS);
        return;
      }
      if (!pending.has(id)) return;
      if (!probed) {
        probed = true;
        probe();
        arm(PROBE_SETTLE_MS);
        return;
      }
      pending.delete(id);
      reject(new Error(REMOTE_CALL_TIMEOUT_MESSAGE));
    }, delay);
  };
  arm(REMOTE_CALL_DEADLINE_MS);
  return () => timers.clearTimeout(timer);
}
