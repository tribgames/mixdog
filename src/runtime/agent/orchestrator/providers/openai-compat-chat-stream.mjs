import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  createTimeoutSignal,
} from '../stall-policy.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import { createLeakGuard, createToolCallDedupe, dedupeToolCallList } from './anthropic-leaked-toolcall.mjs';
import { truncatedCompatStreamError } from './lib/openai-tool-args.mjs';
import {
  closeCompatStream,
  emitCompatToolCallOnce,
  firstByteCompatStreamError,
  markErrorLiveTextEmitted,
  markUnsafeRetryIfToolEmitted,
  nextAsyncWithWatchdog,
  synthLeakedOpenAICall,
} from './openai-compat-stream-common.mjs';

function mergeToolCallDelta(accByIndex, deltaCalls, bucketState) {
  for (const tc of deltaCalls || []) {
    let key;
    if (Number.isFinite(Number(tc?.index))) {
      key = `n:${Number(tc.index)}`;
    } else if (tc.id) {
      key = `id:${tc.id}`;
    } else if (tc.function?.name) {
      const anonId = ++bucketState._nextAnonId;
      key = `anon:${anonId}`;
    } else {
      key = bucketState._lastAnonKey;
      if (!key) continue;
    }
    // Bare argument deltas continue the most recently identified call.
    bucketState._lastAnonKey = key;
    let prev = accByIndex.get(key);
    if (!prev) {
      prev = {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
        _order: ++bucketState._orderSeq,
      };
      accByIndex.set(key, prev);
    }
    if (tc.id) prev.id = tc.id;
    if (tc.type) prev.type = tc.type;
    if (tc.function?.name && !prev.function.name) prev.function.name = tc.function.name;
    if (tc.function?.arguments) {
      const delta = tc.function.arguments;
      // Preserve support for providers that repeat cumulative arguments.
      if (prev.function.arguments && delta.startsWith(prev.function.arguments)) {
        prev.function.arguments = delta;
      } else {
        prev.function.arguments += delta;
      }
    }
  }
}

function toolCallsFromStreamAcc(accByIndex, parseToolCalls, label, finishReason) {
  if (!accByIndex.size) return undefined;
  const choice = {
    // The observed terminal reason distinguishes bad JSON from truncation.
    finish_reason: finishReason || null,
    message: {
      tool_calls: [...accByIndex.values()]
        .sort((a, b) => a._order - b._order)
        .map((v) => {
          const { _order, ...rest } = v;
          return rest;
        }),
    },
  };
  return parseToolCalls(choice, label);
}

export async function consumeCompatChatCompletionStream(
  stream,
  { signal, label, onStreamDelta, onToolCall, onTextDelta, parseToolCalls, knownToolNames, semanticIdleTimeoutMs } = {}
) {
  try {
    onStreamDelta?.('transport');
  } catch {}
  const iterator = stream[Symbol.asyncIterator]();
  let iteratorDone = false;
  const firstByteTimeout = createTimeoutSignal(signal, PROVIDER_FIRST_BYTE_TIMEOUT_MS, `${label} first byte`);
  const idleOverrideEnabled = Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0;
  const idleEnabled = idleOverrideEnabled || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  const idleMs =
    Number.isFinite(Number(semanticIdleTimeoutMs)) && Number(semanticIdleTimeoutMs) > 0
      ? Number(semanticIdleTimeoutMs)
      : PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
  let semanticIdleDeadlineAt = 0;
  const reportProgress = (kind) => {
    if (kind !== 'transport') semanticIdleDeadlineAt = Date.now() + idleMs;
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  let sawFirstEvent = false;
  let content = '';
  let reasoningContent = '';
  let sawReasoningContent = false;
  const reasoningDetails = [];
  // Both text and reasoning exposure prohibit resampling the request.
  let emittedText = false;
  let emittedReasoning = false;
  let model = '';
  let responseId = '';
  let stopReason = null;
  let rawUsage = null;
  const toolAcc = new Map();
  const toolBucketState = { _orderSeq: 0, _nextAnonId: 0, _lastAnonKey: null };
  const _toolDedupe = createToolCallDedupe();
  const streamEmitState = {
    emittedToolCallKeys: new Set(),
    emittedToolCall: false,
    _toolDedupe,
  };
  const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
  const dispatchLeakedCall = (recovered) => {
    const call = synthLeakedOpenAICall(recovered);
    emitCompatToolCallOnce(streamEmitState, call, onToolCall);
    reportProgress('tool');
    return call;
  };
  const leakedCalls = [];
  // Every rejection carries the exposure evidence used by upstream retry gates.
  const _stampCompatOutcome = (err, extra = {}) => {
    try {
      stampStreamOutcome(err, {
        transport: STREAM_TRANSPORTS.SSE,
        provider: 'openai-compat',
        terminalObserved: !!stopReason,
        continuation: !stopReason,
        textEmitted: emittedText === true,
        textObservedChars: content.length,
        reasoningEmitted: emittedReasoning === true || reasoningContent.length > 0,
        toolCallsStarted: toolAcc.size > 0 || leakedCalls.length > 0,
        toolCallsComplete: leakedCalls.length,
        toolCallsDispatched: streamEmitState.emittedToolCall === true ? Math.max(1, leakedCalls.length) : 0,
        pendingToolInput: toolAcc.size > 0,
        ...extra,
      });
    } catch {
      /* stamping is best-effort */
    }
    return err;
  };
  const relayText = (delta) => {
    const { text, calls } = leakGuard.push(delta);
    if (text) {
      content += text;
      reportProgress('text');
      if (onTextDelta) {
        emittedText = true;
        try {
          onTextDelta(text);
        } catch {}
      }
    }
    for (const c of calls) leakedCalls.push(dispatchLeakedCall(c));
  };
  const flushLeak = () => {
    const { text, calls } = leakGuard.flush();
    if (text) {
      content += text;
      reportProgress('text');
      if (onTextDelta) {
        emittedText = true;
        try {
          onTextDelta(text);
        } catch {}
      }
    }
    for (const c of calls) leakedCalls.push(dispatchLeakedCall(c));
  };
  try {
    while (true) {
      const { value: chunk, done } = await nextAsyncWithWatchdog(iterator, {
        signal: sawFirstEvent ? signal : firstByteTimeout.signal,
        idleMs,
        idleDeadlineAt: semanticIdleDeadlineAt,
        idleEnabled: sawFirstEvent && idleEnabled && semanticIdleDeadlineAt > 0,
        idleLabel: `${label} SSE idle`,
        emittedToolCall: () => streamEmitState.emittedToolCall || toolAcc.size > 0,
      });
      if (done) {
        iteratorDone = true;
        break;
      }
      if (!sawFirstEvent) {
        sawFirstEvent = true;
        firstByteTimeout.cleanup();
      }
      try {
        onStreamDelta?.('transport');
      } catch {}
      if (chunk?.id) responseId = chunk.id;
      if (chunk?.model) model = chunk.model;
      const choice = chunk?.choices?.[0];
      if (typeof choice?.delta?.role === 'string' && choice.delta.role) {
        reportProgress('semantic');
      }
      if (choice?.delta?.content) {
        if (leakGuard.enabled) {
          relayText(choice.delta.content);
        } else {
          content += choice.delta.content;
          reportProgress('text');
          if (onTextDelta) {
            emittedText = true;
            try {
              onTextDelta(choice.delta.content);
            } catch {}
          }
        }
      }
      if (Array.isArray(choice?.delta?.reasoning_details) && choice.delta.reasoning_details.length) {
        reasoningDetails.push(...choice.delta.reasoning_details);
        reportProgress('reasoning');
      }
      // These provider fields are aliases, never independent text segments.
      const reasoningDelta =
        typeof choice?.delta?.reasoning_content === 'string'
          ? choice.delta.reasoning_content
          : typeof choice?.delta?.reasoning === 'string'
            ? choice.delta.reasoning
            : typeof choice?.delta?.thinking === 'string'
              ? choice.delta.thinking
              : null;
      if (reasoningDelta !== null) {
        sawReasoningContent = true;
        reasoningContent += reasoningDelta;
        if (reasoningDelta) {
          emittedReasoning = true;
          reportProgress('reasoning');
        }
      }
      if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) {
        reportProgress('tool');
      }
      mergeToolCallDelta(toolAcc, choice?.delta?.tool_calls, toolBucketState);
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk?.usage) rawUsage = chunk.usage;
    }
    if (leakGuard.enabled) flushLeak();
  } catch (err) {
    // Keep exposed partial text without permitting the request to replay.
    if (emittedText) {
      markErrorLiveTextEmitted(err);
      try {
        err.partialContent = content;
        err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
        err.partialModel = model || undefined;
      } catch {
        /* best-effort */
      }
      throw _stampCompatOutcome(markUnsafeRetryIfToolEmitted(err, streamEmitState));
    }
    if (err?.streamStalled === true) {
      try {
        err.partialContent = content;
        err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
        err.partialModel = model || undefined;
      } catch {
        /* best-effort */
      }
    }
    throw _stampCompatOutcome(markUnsafeRetryIfToolEmitted(err, streamEmitState));
  } finally {
    firstByteTimeout.cleanup();
    if (!iteratorDone) closeCompatStream(stream, iterator);
  }
  if (!sawFirstEvent) {
    if (firstByteTimeout.signal?.aborted) throw _stampCompatOutcome(firstByteCompatStreamError(label));
    throw _stampCompatOutcome(firstByteCompatStreamError(label));
  }
  if (!stopReason) {
    const err = truncatedCompatStreamError(label, 'no finish_reason');
    if (emittedText) {
      markErrorLiveTextEmitted(err);
      try {
        err.streamStalled = true;
        err.partialContent = content;
        err.pendingToolUse = toolAcc.size > 0 || leakedCalls.length > 0;
        err.partialModel = model || undefined;
      } catch {
        /* best-effort */
      }
    }
    throw _stampCompatOutcome(markUnsafeRetryIfToolEmitted(err, streamEmitState));
  }
  const message = {
    content: content || null,
    ...(sawReasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
  };
  const rawToolCalls = [...toolAcc.values()]
    .sort((a, b) => a._order - b._order)
    .map((v) => {
      const { _order, ...rest } = v;
      return rest;
    })
    .filter((tc) => tc.id || tc.function?.name);
  if (rawToolCalls.length) message.tool_calls = rawToolCalls;
  const response = {
    id: responseId || null,
    model: model || null,
    choices: [{ message, finish_reason: stopReason }],
    usage: rawUsage || undefined,
  };
  let toolCalls;
  try {
    toolCalls = toolCallsFromStreamAcc(toolAcc, parseToolCalls, label, stopReason);
  } catch (err) {
    if (stopReason && err.truncatedStream) {
      try {
        err.message += ` finish_reason=${stopReason}`;
      } catch {}
    }
    if (emittedText) markErrorLiveTextEmitted(err);
    throw _stampCompatOutcome(markUnsafeRetryIfToolEmitted(err, streamEmitState));
  }
  if (Array.isArray(toolCalls) && toolCalls.length) {
    for (const call of toolCalls) emitCompatToolCallOnce(streamEmitState, call, onToolCall);
  }
  if (leakedCalls.length) {
    toolCalls = dedupeToolCallList([...(Array.isArray(toolCalls) ? toolCalls : []), ...leakedCalls]);
  }
  return {
    response,
    model,
    content,
    toolCalls,
    stopReason,
    reasoningContent: sawReasoningContent ? reasoningContent : null,
    reasoningDetails: reasoningDetails.length ? reasoningDetails : null,
    rawUsage,
  };
}
