// First-byte and idle watchdogs of one Gemini REST SSE body. Either timeout
// cancels the reader and fails the pending read, so the caller surfaces a typed
// timeout instead of waiting on a stalled socket. The idle timer re-arms only
// on decoded payloads (semantic progress), so it uses the semantic window.
// Each timeout names its phase (`timeoutPhase`): 'first-chunk' before any
// payload, 'idle' after one.
import { PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_SSE_IDLE_WATCHDOG_ENABLED } from '../../stall-policy.mjs';
import { TIMEOUT_PHASE } from '../../../../shared/provider-timeout-phase.mjs';

export function createRestStreamWatchdogs({ reader, label, firstByteTimeoutMs, timeoutError }) {
  let idleTimedOut = false;
  let idleTimer = null;
  let pendingReject = null;

  const cancelReader = (reason) => {
    try {
      reader.cancel(reason).catch(() => {});
    } catch {}
  };
  const failPending = (err) => {
    if (!pendingReject) return;
    const reject = pendingReject;
    pendingReject = null;
    reject(err);
  };
  const idleError = () =>
    Object.assign(timeoutError(`${label} SSE idle`, PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS), {
      timeoutPhase: TIMEOUT_PHASE.IDLE,
    });

  let firstByteTimer = setTimeout(() => {
    cancelReader('first byte timeout');
    failPending(
      Object.assign(timeoutError(`${label} first byte`, firstByteTimeoutMs), {
        timeoutPhase: TIMEOUT_PHASE.FIRST_CHUNK,
      })
    );
  }, firstByteTimeoutMs);
  firstByteTimer.unref?.();
  const clearFirstByte = () => {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
  };

  return {
    get idleTimedOut() {
      return idleTimedOut;
    },
    idleError,
    clearFirstByte,
    resetIdle() {
      if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        cancelReader('SSE idle timeout');
        failPending(idleError());
      }, PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    },
    // One reader.read() with its reject handle registered for the watchdogs;
    // the caller clears the handle once the read settled either way.
    read() {
      return new Promise((resolve, reject) => {
        pendingReject = reject;
        reader.read().then(resolve, reject);
      });
    },
    clearPending() {
      pendingReject = null;
    },
    stop() {
      clearFirstByte();
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}
