/**
 * openai-compat-chat-stream.mjs — consuming an OpenAI-compatible
 * chat-completions SSE stream: the read loop with first-byte and semantic
 * idle watchdogs, and the exposure-preserving failure path. The per-chunk
 * projection, the stream state and the settlement live under
 * openai-compat-chat-stream/.
 */
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  createTimeoutSignal,
} from '../stall-policy.mjs';
import {
  closeCompatStream,
  markErrorLiveTextEmitted,
  markUnsafeRetryIfToolEmitted,
  nextAsyncWithWatchdog,
} from './openai-compat-stream-common.mjs';
import {
  attachPartial,
  createCompatStreamState,
  flushLeak,
  reportTransport,
  stampCompatOutcome,
  toolWorkStarted,
} from './openai-compat-chat-stream/stream-state.mjs';
import { applyCompatChunk } from './openai-compat-chat-stream/chunk-events.mjs';
import { incompleteStreamError, settleCompatStream } from './openai-compat-chat-stream/stream-result.mjs';

export async function consumeCompatChatCompletionStream(
  stream,
  { signal, label, onStreamDelta, onToolCall, onTextDelta, parseToolCalls, knownToolNames, semanticIdleTimeoutMs } = {}
) {
  const idleOverrideEnabled = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0;
  const idleEnabled = idleOverrideEnabled || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  const idleMs = idleOverrideEnabled ? Number(semanticIdleTimeoutMs) : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
  const state = createCompatStreamState({ knownToolNames, idleMs, onStreamDelta, onToolCall, onTextDelta });
  reportTransport(state);
  const iterator = stream[Symbol.asyncIterator]();
  let iteratorDone = false;
  const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
  try {
    while (true) {
      const { value: chunk, done } = await nextAsyncWithWatchdog(iterator, {
        signal: state.sawFirstEvent ? signal : firstByteTimeout.signal,
        idleMs,
        idleDeadlineAt: state.semanticIdleDeadlineAt,
        idleEnabled: state.sawFirstEvent && idleEnabled && state.semanticIdleDeadlineAt > 0,
        idleLabel: `${label} SSE idle`,
        emittedToolCall: () => toolWorkStarted(state),
      });
      if (done) {
        iteratorDone = true;
        break;
      }
      if (!state.sawFirstEvent) {
        state.sawFirstEvent = true;
        firstByteTimeout.cleanup();
      }
      applyCompatChunk(state, chunk);
    }
    if (state.leakGuard.enabled) flushLeak(state);
  } catch (err) {
    // Keep exposed partial text without permitting the request to replay.
    if (state.emittedText) markErrorLiveTextEmitted(err);
    if (state.emittedText || err?.streamStalled === true) attachPartial(state, err);
    throw stampCompatOutcome(state, markUnsafeRetryIfToolEmitted(err, state.streamEmitState));
  } finally {
    firstByteTimeout.cleanup();
    if (!iteratorDone) closeCompatStream(stream, iterator);
  }
  if (!state.sawFirstEvent || !state.stopReason) throw incompleteStreamError(state, label);
  return settleCompatStream(state, { label, parseToolCalls });
}
