// Pending-read registry and watchdogs for the Gemini SDK iterator.
//
// One read is in flight at a time. Its reject handle is registered so the
// first-byte timer, the idle watchdog and an external abort can fail the read
// immediately instead of waiting for the SDK to notice.
import { PROVIDER_SSE_IDLE_TIMEOUT_MS, PROVIDER_SSE_IDLE_WATCHDOG_ENABLED } from '../../stall-policy.mjs';

export function createSdkStreamReader({ iterator, label, firstByteTimeoutMs, timeoutError, cancellation }) {
  let sawStreamChunk = false;
  let idleTimedOut = false;
  let idleTimer = null;
  let firstByteTimer = null;
  let firstByteReject = null;
  let inFlightReject = null;

  const idleError = () => timeoutError(`${label} SSE idle`, PROVIDER_SSE_IDLE_TIMEOUT_MS);
  const clearPending = () => {
    inFlightReject = null;
    firstByteReject = null;
  };

  const armFirstByteTimer = () => {
    if (firstByteTimer) clearTimeout(firstByteTimer);
    firstByteTimer = setTimeout(() => {
      if (firstByteReject) {
        const e = timeoutError(`${label} first byte`, firstByteTimeoutMs);
        const r = firstByteReject;
        firstByteReject = null;
        cancellation.rejectAfterCancellation(r, e);
      }
    }, firstByteTimeoutMs);
  };
  const clearFirstByteTimer = () => {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
    firstByteReject = null;
  };
  const resetIdleTimer = () => {
    if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      if (inFlightReject) {
        const r = inFlightReject;
        inFlightReject = null;
        cancellation.rejectAfterCancellation(r, idleError());
      }
    }, PROVIDER_SSE_IDLE_TIMEOUT_MS);
  };

  return {
    get sawStreamChunk() {
      return sawStreamChunk;
    },
    get idleTimedOut() {
      return idleTimedOut;
    },
    idleError,
    // Arm both watchdogs once the abort listener is in place.
    arm() {
      armFirstByteTimer();
      resetIdleTimer();
    },
    clearFirstByte: clearFirstByteTimer,
    // Stop every watchdog (completion or the finally path).
    stop() {
      clearFirstByteTimer();
      if (idleTimer) clearTimeout(idleTimer);
    },
    // External abort: fail the pending read now; the SDK iterator may
    // propagate the transport abort only after its own asynchronous cleanup.
    rejectPending(err) {
      if (!inFlightReject) return;
      const r = inFlightReject;
      clearPending();
      r(err);
    },
    // Resolve the next SDK step with its reject handle registered for the
    // watchdogs; a settlement after a forced cancellation reports that failure.
    next() {
      return new Promise((resolve, reject) => {
        inFlightReject = reject;
        if (!sawStreamChunk) firstByteReject = reject;
        iterator.next().then(
          (value) => {
            clearPending();
            if (!cancellation.settleForced(reject)) resolve(value);
          },
          (err) => {
            clearPending();
            if (!cancellation.settleForced(reject)) reject(err);
          }
        );
      });
    },
    // A delivered chunk retires the first-byte timer and restarts the idle
    // watchdog.
    noteChunk() {
      if (!sawStreamChunk) {
        sawStreamChunk = true;
        clearFirstByteTimer();
      }
      resetIdleTimer();
    },
  };
}
