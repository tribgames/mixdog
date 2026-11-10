// Abort wiring of one POST: the session-lifetime signal and the per-attempt
// signal both abort the fetch controller. The attempt listener is released as
// soon as headers arrive; the session listener stays until the caller is done
// with the response.
const SESSION_ABORT_MESSAGE = 'Anthropic OAuth request aborted by session close';
const ATTEMPT_ABORT_MESSAGE = 'Anthropic OAuth request attempt aborted';

const abortReason = (signal, message) => (signal.reason instanceof Error ? signal.reason : new Error(message));

export function removeAbortListener(signal, handler) {
  if (!handler) return;
  try {
    signal.removeEventListener('abort', handler);
  } catch {}
}

export function wireRequestAbort({ controller, totalSignal, requestSignal }) {
  let cancelHandler = null;
  if (totalSignal) {
    if (totalSignal.aborted) {
      controller.abort(totalSignal.reason);
      throw abortReason(totalSignal, SESSION_ABORT_MESSAGE);
    }
    cancelHandler = () => {
      try {
        controller.abort(totalSignal.reason);
      } catch {}
    };
    totalSignal.addEventListener('abort', cancelHandler, { once: true });
  }
  let attemptCancelHandler = null;
  if (requestSignal && requestSignal !== totalSignal) {
    if (requestSignal.aborted) {
      removeAbortListener(totalSignal, cancelHandler);
      controller.abort(requestSignal.reason);
      throw abortReason(requestSignal, ATTEMPT_ABORT_MESSAGE);
    }
    attemptCancelHandler = () => {
      try {
        controller.abort(requestSignal.reason);
      } catch {}
    };
    requestSignal.addEventListener('abort', attemptCancelHandler, { once: true });
  }
  return {
    cancelHandler,
    releaseAttempt() {
      removeAbortListener(requestSignal, attemptCancelHandler);
    },
    releaseSession() {
      removeAbortListener(totalSignal, cancelHandler);
    },
    // The failure to surface when the fetch rejected: the abort reason when
    // either signal fired, a typed timeout when the fetch itself aborted, else
    // the original error.
    failure(err, requestTimeoutMs) {
      if (requestSignal?.aborted) return abortReason(requestSignal, ATTEMPT_ABORT_MESSAGE);
      if (totalSignal?.aborted) return abortReason(totalSignal, SESSION_ABORT_MESSAGE);
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error(`Anthropic OAuth API initial response timed out after ${requestTimeoutMs}ms`);
        timeoutErr.code = 'EPROVIDERTIMEOUT';
        return timeoutErr;
      }
      return err;
    },
  };
}
