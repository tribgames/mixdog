// OpenAI-compat Responses SSE consumer. Event handling lives in
// openai-compat-responses-events.mjs and the stream state / leak relay /
// outcome stamp in openai-compat-responses-state.mjs; this file owns the
// watchdog-driven read loop and its terminal checks.
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  createTimeoutSignal,
} from '../stall-policy.mjs';
import {
  closeCompatStream,
  firstByteCompatStreamError,
  markErrorLiveTextEmitted,
  markUnsafeRetryIfToolEmitted,
  nextAsyncWithWatchdog,
} from './openai-compat-stream-common.mjs';
import {
  truncatedCompatStreamError,
  makeInvalidToolArgsMarker,
  isInvalidToolArgsMarker,
  formatInvalidToolArgsResult,
  parseCompletedToolCallArgumentsJson,
} from './lib/openai-tool-args.mjs';
import { handleCompatResponsesStreamEvent } from './openai-compat-responses-events.mjs';
import {
  attachPartialState,
  createResponsesLeakRelay,
  createResponsesOutcomeStamper,
  createResponsesStreamState,
  finalizeResponsesStream,
  unresolvedSalvageError,
} from './openai-compat-responses-state.mjs';

export {
  makeInvalidToolArgsMarker,
  isInvalidToolArgsMarker,
  formatInvalidToolArgsResult,
  parseCompletedToolCallArgumentsJson,
};
export { consumeCompatChatCompletionStream } from './openai-compat-chat-stream.mjs';

export async function consumeCompatResponsesStream(
  stream,
  {
    signal,
    label,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    parseResponsesToolCalls,
    responseOutputText,
    knownToolNames,
    semanticIdleTimeoutMs,
  } = {}
) {
  try {
    onStreamDelta?.('transport');
  } catch {}
  const iterator = stream[Symbol.asyncIterator]();
  let iteratorDone = false;
  const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
  const idleOverrideEnabled = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0;
  const idleEnabled = idleOverrideEnabled || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  // Per-event (last-event-relative) SEMANTIC idle — see the Chat path note.
  const idleMs = idleOverrideEnabled ? Number(semanticIdleTimeoutMs) : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
  const state = createResponsesStreamState();
  const reportProgress = (kind) => {
    if (kind !== 'transport') state.semanticIdleDeadlineAt = Date.now() + idleMs;
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  let sawFirstEvent = false;
  const { relayLeakText, flushLeak, leakedCalls } = createResponsesLeakRelay({
    state,
    knownToolNames,
    onToolCall,
    onTextDelta,
    reportProgress,
  });
  const deps = {
    label,
    parseResponsesToolCalls,
    responseOutputText,
    onStreamDelta: reportProgress,
    onToolCall,
    onTextDelta,
    relayLeakText,
  };
  const stampOutcome = createResponsesOutcomeStamper(state, leakedCalls);
  try {
    while (true) {
      const { value: event, done } = await nextAsyncWithWatchdog(iterator, {
        signal: sawFirstEvent ? signal : firstByteTimeout.signal,
        idleMs,
        idleDeadlineAt: state.semanticIdleDeadlineAt,
        idleEnabled: sawFirstEvent && idleEnabled && state.semanticIdleDeadlineAt > 0,
        idleLabel: `${label} SSE idle`,
        // Unsafe-to-retry once any tool call (native or recovered-leaked)
        // has been emitted this stream — avoid a double side-effect.
        emittedToolCall: () => state.emittedToolCall || leakedCalls.length > 0,
      });
      if (done) {
        iteratorDone = true;
        break;
      }
      if (!sawFirstEvent) {
        sawFirstEvent = true;
        firstByteTimeout.cleanup();
      }
      reportProgress('transport');
      handleCompatResponsesStreamEvent(event, state, deps);
    }
    flushLeak();
  } catch (err) {
    // Partial-final recovery: attach streamed partial state so a
    // wedged FINAL no-tool summary can be accepted as partial-final success.
    if (err?.streamStalled === true) attachPartialState(err, state, leakedCalls);
    throw stampOutcome(markUnsafeRetryIfToolEmitted(err, state));
  } finally {
    firstByteTimeout.cleanup();
    if (!iteratorDone) closeCompatStream(stream, iterator);
  }
  if (!sawFirstEvent) {
    // Pre-output: nothing was sampled, so this stays replay-safe.
    throw stampOutcome(firstByteCompatStreamError(label));
  }
  if (!state.completed) {
    const err = truncatedCompatStreamError(label, 'no response.completed');
    if (state.emittedText) {
      // Truncation after visible output: keep the streamed partial
      // (same rule) so the loop can finalize it as partial-final instead
      // of dropping the turn. liveText marking still blocks replay.
      markErrorLiveTextEmitted(err);
      err.streamStalled = true;
      attachPartialState(err, state, leakedCalls);
    }
    throw stampOutcome(err);
  }
  const unresolved = unresolvedSalvageError(state);
  if (unresolved) throw stampOutcome(unresolved);
  return finalizeResponsesStream(state, { leakedCalls, parseResponsesToolCalls, responseOutputText, label });
}
