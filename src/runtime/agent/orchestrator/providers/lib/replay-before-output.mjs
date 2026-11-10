import { isVisibleStreamProgress } from '../../../../shared/stream-progress.mjs';

/**
 * Runs `send(opts)` with the caller's stream callbacks watched. When it fails
 * before any output reached the caller and the send was not cancelled,
 * `replayOpts(error, trackedOpts)` returns the options of one replay, or null
 * to rethrow. A late error never replays.
 */
export async function sendWithReplayBeforeOutput(opts, send, replayOpts) {
  let streamed = false;
  const track =
    (callback, isProgress = false) =>
    (...args) => {
      if (!isProgress || isVisibleStreamProgress(args[0])) streamed = true;
      return callback(...args);
    };
  const tracked = { ...opts };
  if (typeof opts?.onStreamDelta === 'function') tracked.onStreamDelta = track(opts.onStreamDelta, true);
  if (typeof opts?.onTextDelta === 'function') tracked.onTextDelta = track(opts.onTextDelta);
  if (typeof opts?.onToolCall === 'function') tracked.onToolCall = track(opts.onToolCall);
  try {
    return await send(tracked);
  } catch (error) {
    const emitted =
      streamed || error?.liveTextEmitted === true || error?.emittedToolCall === true || error?.unsafeToRetry === true;
    const next = emitted || opts?.signal?.aborted ? null : replayOpts(error, tracked);
    if (!next) throw error;
    return send(next);
  }
}
