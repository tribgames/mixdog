/**
 * anthropic-sse-watchdogs.mjs — liveness gates of one Anthropic SSE stream:
 * the first-message window (no message_start yet), the transport-idle window
 * (mid-stream silence), and the cancellable reader.read() race both use to
 * force-unblock a pending read that reader.cancel() failed to settle (undici
 * half-open socket — the 391s-hang root cause).
 */
import { runAbortable } from '../../../shared/abort-race.mjs';
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  PROVIDER_SSE_IDLE_TIMEOUT_MS,
  streamStalledError,
} from '../stall-policy.mjs';

const log = (line) => {
  try {
    process.stderr.write(`[anthropic-oauth] ${line}\n`);
  } catch {}
};

function positiveMs(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

/**
 * @param {object} deps
 * @param {object|null} deps.state  midState (test seams + sawMessageStart)
 * @param {ReadableStreamDefaultReader} deps.reader
 * @param {AbortSignal|null} deps.signal
 * @param {((reason?: Error) => void)|null} deps.abortStream
 * @param {(err: Error) => Error} deps.attachStallPartial  enriches the idle-stall error
 */
export function createAnthropicSseWatchdogs({ state, reader, signal, abortStream, attachStallPartial }) {
  // Transport-idle window. The legacy semanticIdleTimeoutMs seam remains as
  // a fallback for existing tests/callers, but production uses the shared
  // byte/event inactivity policy.
  const idleTimeoutMs =
    positiveMs(state?.transportIdleTimeoutMs ?? state?.semanticIdleTimeoutMs) || PROVIDER_SSE_IDLE_TIMEOUT_MS;
  const idleWatchdogEnabled =
    typeof state?.transportIdleWatchdogEnabled === 'boolean'
      ? state.transportIdleWatchdogEnabled
      : PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  const firstMessageTimeoutMs = positiveMs(state?.firstMessageTimeoutMs) || PROVIDER_FIRST_BYTE_TIMEOUT_MS;
  let idleTimedOut = false;
  let firstMessageTimedOut = false;
  let idleTimer = null;
  let firstMessageTimer = null;
  // Holds the in-flight reader.read() race rejector so a timer can
  // force-unblock the loop even when reader.cancel() fails to settle the
  // pending read.
  let idleReject = null;
  const rejectPendingRead = (err) => {
    if (!idleReject) return;
    const r = idleReject;
    idleReject = null;
    r(err);
  };
  const cancelReader = (reason, label) => {
    try {
      const c = reader.cancel(reason);
      if (c && typeof c.catch === 'function') c.catch(() => {});
    } catch (err) {
      log(`sse ${label} cancel failed: ${err?.message ?? String(err)}`);
    }
  };

  const firstMessageTimeoutError = () => {
    const err = new Error(`Anthropic OAuth SSE stream produced no message_start within ${firstMessageTimeoutMs}ms`);
    err.code = 'EEMPTYSTREAM';
    err.isEmptyStream = true;
    err.firstByteTimeout = true;
    return err;
  };
  const clearFirstMessageTimer = () => {
    if (firstMessageTimer) {
      clearTimeout(firstMessageTimer);
      firstMessageTimer = null;
    }
  };
  // Do not arm the transport-idle timer before the stream has produced its
  // first event. A slow first response is governed by this first-byte window
  // alone; arming the transport idle earlier could let it win and mis-abort a
  // legitimately slow first response as a stall.
  const armFirstMessageTimer = () => {
    if (!(firstMessageTimeoutMs > 0)) return;
    clearFirstMessageTimer();
    firstMessageTimer = setTimeout(() => {
      if (state?.sawMessageStart) return;
      firstMessageTimedOut = true;
      const err = firstMessageTimeoutError();
      try {
        abortStream?.(err);
      } catch (abortErr) {
        log(`sse first-message abortStream failed: ${abortErr?.message ?? String(abortErr)}`);
      }
      cancelReader('SSE first message timeout', 'first-message');
      rejectPendingRead(err);
    }, firstMessageTimeoutMs);
    try {
      firstMessageTimer.unref?.();
    } catch {}
  };

  const stallError = () =>
    attachStallPartial(
      streamStalledError('Anthropic OAuth SSE', idleTimeoutMs, { emittedToolCall: !!state?.emittedToolCall })
    );
  // Only actual transport silence trips this. Anthropic keepalives prove
  // that the generation connection is still alive.
  const resetIdleTimer = () => {
    if (!idleWatchdogEnabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      try {
        abortStream?.();
      } catch (err) {
        log(`sse idle abortStream failed: ${err?.message ?? String(err)}`);
      }
      cancelReader('SSE idle timeout', 'idle');
      // Force-reject the in-flight reader.read() race even when
      // reader.cancel() fails to settle the pending read: without this the
      // awaited read stays pending forever and the idle timeout never
      // unblocks the loop.
      if (idleReject) rejectPendingRead(stallError());
    }, idleTimeoutMs);
    try {
      idleTimer.unref?.();
    } catch {}
  };

  // Race the read against the timers' rejector so a stuck reader.read()
  // (cancel did not settle it) still unblocks here.
  const read = async () => {
    try {
      return await runAbortable(
        signal,
        () =>
          new Promise((resolve, reject) => {
            idleReject = reject;
            reader.read().then(resolve, reject);
          }),
        'Anthropic OAuth SSE stream aborted'
      );
    } finally {
      idleReject = null;
    }
  };
  // Map a failed read to the watchdog that caused it, or null when the
  // failure was not a watchdog's.
  const readFailure = () => {
    if (idleTimedOut) return stallError();
    if (firstMessageTimedOut) return firstMessageTimeoutError();
    return null;
  };
  const dispose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearFirstMessageTimer();
  };
  return { armFirstMessageTimer, clearFirstMessageTimer, resetIdleTimer, read, readFailure, dispose };
}
