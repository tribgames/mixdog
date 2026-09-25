/**
 * gemini-stream.mjs — Gemini stream consumption (REST + SDK) and stream guards.
 *
 * Owns chunk aggregation, completion assertions,
 * timeout/truncation error shapes and the text leak guard that recovers
 * tool calls emitted as plain text.
 */
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_MAX_BEFORE_WARN_MS,
  providerTimeoutError,
  resolveTimeoutMs,
} from '../stall-policy.mjs';
import { knownToolNameSet, scanLeakedToolCalls, toolCallFingerprint } from './anthropic-leaked-toolcall.mjs';
import { traceHash, stableTraceStringify } from './trace-utils.mjs';
import { parseGeminiTextPartMetadata } from './gemini-schema.mjs';
import { parseProviderJsonBatch } from './stream-json-pool.mjs';
import { runAbortable } from '../../../shared/abort-race.mjs';
import { createSdkStreamCancellation } from './gemini-sdk-stream/cancellation.mjs';
import { createSdkStreamReader } from './gemini-sdk-stream/reader.mjs';
import { createRestStreamWatchdogs } from './gemini-rest-stream/watchdogs.mjs';
import { drainSseDataLines, sseDataPayload } from './gemini-rest-stream/sse-lines.mjs';

export const GEMINI_FIRST_BYTE_TIMEOUT_MS = resolveTimeoutMs(
  'MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS',
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  { minMs: 30_000, maxMs: PROVIDER_MAX_BEFORE_WARN_MS }
);

export function geminiTimeoutError(label, timeoutMs) {
  const err = providerTimeoutError(label, timeoutMs);
  err.name = 'GeminiTimeoutError';
  err.code = 'EGEMINITIMEOUT';
  return err;
}

const GEMINI_RPC_CODES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'ABORTED', 'INTERNAL', 'RESOURCE_EXHAUSTED']);

/**
 * Copy a typed Gemini/gRPC status onto the error so classifyError can retry
 * UNAVAILABLE/DEADLINE_EXCEEDED/ABORTED/INTERNAL without an HTTP status.
 */
export function stampGeminiRpcError(err) {
  if (!err || typeof err !== 'object') return err;
  if (typeof err.geminiStatus === 'string' && err.geminiStatus) return err;
  for (const field of [err.status, err.error?.status, err.cause?.status, err.cause?.geminiStatus]) {
    if (typeof field === 'string' && GEMINI_RPC_CODES.has(field.toUpperCase())) {
      err.geminiStatus = field.toUpperCase();
      return err;
    }
  }
  return err;
}

function geminiTruncatedStreamError(message) {
  return Object.assign(new Error(message), {
    name: 'TruncatedStreamError',
    code: 'TRUNCATED_STREAM',
    truncatedStream: true,
  });
}

function geminiStreamCorruptionError(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    name: 'GeminiStreamCorruptionError',
    code: 'TRUNCATED_STREAM',
    truncatedStream: true,
    streamCorruption: true,
  });
}

function isGeminiSdkStreamParseError(err) {
  let cursor = err;
  const seen = new Set();
  for (let depth = 0; cursor && depth < 5 && !seen.has(cursor); depth++) {
    seen.add(cursor);
    if (cursor instanceof SyntaxError) return true;
    const name = String(cursor?.name || '');
    const message = String(cursor?.message || '');
    if (
      name === 'GoogleGenerativeAIError' &&
      /(?:parse|parsing|json|unexpected token|unexpected end|unterminated)/i.test(message)
    ) {
      return true;
    }
    cursor = cursor?.cause;
  }
  return false;
}

function normalizeGeminiSdkStreamError(err, label) {
  const stamped = stampGeminiRpcError(err);
  return isGeminiSdkStreamParseError(stamped)
    ? geminiStreamCorruptionError(`${label} corrupt SDK SSE JSON`, stamped)
    : stamped;
}

// CC-rule safety stamp for Gemini stream failures (provider-stall audit):
// once text has actually been RELAYED to the live gateway or a leaked tool
// call was dispatched, replaying would double-render/double-execute — the
// outer withRetry() in gemini.mjs wraps the WHOLE stream, and a bare
// EGEMINITIMEOUT classifies transient, so without these markers a mid-stream
// stall after visible output was silently retried. Text that was only
// BUFFERED (no onTextDelta sink, or still held inside the leak guard) was
// never shown, so it is not a replay boundary. Relayed-text stalls also gain
// streamStalled + partialContent so the loop's partial-final path can keep
// the streamed output instead of dropping the turn.
function stampGeminiStreamFailure(err, { relayedText = '', textLeakGuard = null, chunks = [] } = {}) {
  if (!err || typeof err !== 'object') return err;
  const leaked = (textLeakGuard?.getLeakedToolCalls?.() || []).length > 0;
  const finalizedText = textLeakGuard?.getRelayedText?.();
  const visibleText = typeof finalizedText === 'string' ? finalizedText : relayedText;
  const visible = visibleText.length > 0;
  // Native functionCall chunks are only dispatched after successful stream
  // completion in gemini.mjs. Until then a reconnect is safe. Text-leaked
  // calls are dispatched while parsing and remain a hard replay boundary.
  const pendingTool = leaked;
  try {
    if (visible) {
      err.liveTextEmitted = true;
      err.unsafeToRetry = true;
    }
    if (pendingTool) {
      err.emittedToolCall = true;
      err.unsafeToRetry = true;
    }
    const partialParts = aggregateGeminiStreamChunks(chunks)?.candidates?.[0]?.content?.parts || [];
    const providerMetadata = parseGeminiTextPartMetadata(partialParts);
    if (providerMetadata) err.providerMetadata = providerMetadata;
    // TRUNCATED_STREAM EOF after visible output must also carry the
    // partial-final stamps (streamStalled/partialContent), aligning with the
    // compat streams — otherwise live output is dropped instead of kept.
    if (
      visible &&
      !leaked &&
      (err.code === 'EGEMINITIMEOUT' || err.code === 'TRUNCATED_STREAM' || err.truncatedStream === true)
    ) {
      err.streamStalled = true;
      if (typeof err.partialContent !== 'string') err.partialContent = visibleText;
      if (err.pendingToolUse === undefined) err.pendingToolUse = pendingTool;
    }
  } catch {
    /* best-effort */
  }
  return err;
}

export function geminiChunkProgressKind(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return 'transport';
  if (parts.some((part) => part?.functionCall)) return 'tool';
  if (parts.some((part) => part?.thought === true && typeof part.text === 'string' && part.text)) {
    return 'reasoning';
  }
  if (parts.some((part) => part?.thought !== true && typeof part?.text === 'string' && part.text)) {
    return 'text';
  }
  return 'transport';
}

/**
 * Aggregate streamed GenerateContentResponse chunks into one response object
 * (same shape as a non-streaming generateContent JSON body).
 * Mirrors @google/generative-ai aggregateResponses().
 */
function aggregateGeminiStreamChunks(responses) {
  const lastResponse = responses[responses.length - 1];
  const aggregatedResponse = {
    promptFeedback: lastResponse?.promptFeedback,
  };
  for (const response of responses) {
    if (response?.candidates) {
      let candidateIndex = 0;
      for (const candidate of response.candidates) {
        if (!aggregatedResponse.candidates) aggregatedResponse.candidates = [];
        if (!aggregatedResponse.candidates[candidateIndex]) {
          aggregatedResponse.candidates[candidateIndex] = { index: candidateIndex };
        }
        const aggCand = aggregatedResponse.candidates[candidateIndex];
        aggCand.citationMetadata = candidate.citationMetadata;
        aggCand.groundingMetadata = candidate.groundingMetadata;
        aggCand.finishReason = candidate.finishReason;
        aggCand.finishMessage = candidate.finishMessage;
        aggCand.safetyRatings = candidate.safetyRatings;
        if (candidate.content?.parts) {
          if (!aggCand.content) {
            aggCand.content = {
              role: candidate.content.role || 'user',
              parts: [],
            };
          }
          for (const part of candidate.content.parts) {
            let newPart;
            try {
              newPart = structuredClone(part);
            } catch {
              newPart = { ...part };
            }
            if (Object.keys(newPart).length === 0) newPart.text = '';
            aggCand.content.parts.push(newPart);
          }
        }
        candidateIndex++;
      }
    }
    if (response?.usageMetadata) aggregatedResponse.usageMetadata = response.usageMetadata;
  }
  return aggregatedResponse;
}

function assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, label }) {
  if (!sawStreamChunk) {
    throw geminiTruncatedStreamError(`${label} truncated: empty stream`);
  }
  if (!finishReason && !promptBlockReason) {
    throw geminiTruncatedStreamError(`${label} truncated: no finishReason`);
  }
}

// Concatenate the text parts of a single streamed Gemini chunk. Used to feed
// the gateway live-text relay (onTextDelta) with the incremental text payload
// as each SSE/SDK chunk arrives. Returns '' for tool-call / thought-only /
// malformed chunks so the caller can skip empty emits.
function geminiChunkText(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    // Thought summaries are reasoning, not user-visible answer deltas.
    if (p && p.thought !== true && typeof p.text === 'string') text += p.text;
  }
  return text;
}

// Returns the text actually RELAYED to the live sink (''  when it was only
// buffered), so callers can track visible output rather than raw stream text.
function relayGeminiStreamText(t, { onTextDelta, textLeakGuard }) {
  if (!t) return '';
  if (textLeakGuard) {
    textLeakGuard.feedText(t);
    return '';
  }
  if (onTextDelta) {
    try {
      onTextDelta(t);
    } catch {}
    return t;
  }
  return '';
}

/**
 * Rolling scanner for tool calls leaked as plain XML/antml tags inside Gemini
 * `part.text` streams. Mirrors the Anthropic OAuth guard: suppress tags from
 * visible text, synthesize known-tool calls, dispatch via onToolCall.
 */
export function createGeminiTextLeakGuard({ knownToolNames, onTextDelta, onToolCall, onStreamDelta }) {
  const _knownTools = knownToolNameSet(knownToolNames);
  const _enabled = _knownTools.size > 0;
  const _isKnownTool = (name) => _knownTools.has(name);
  let leakBuffer = '';
  let relayedText = '';
  const leakedCalls = [];
  const dispatchedFingerprints = new Set();

  const dispatchLeakedCall = (recovered) => {
    let args = recovered?.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
    const fp = toolCallFingerprint(recovered.name, args);
    if (dispatchedFingerprints.has(fp)) return;
    dispatchedFingerprints.add(fp);
    const idHash = traceHash(
      stableTraceStringify({
        name: recovered.name,
        args,
        leak: true,
      })
    ).slice(0, 16);
    const call = {
      id: `gemini_leaked_${idHash}`,
      name: recovered.name,
      arguments: args,
    };
    leakedCalls.push(call);
    try {
      onToolCall?.(call);
    } catch {}
    try {
      onStreamDelta?.('tool');
    } catch {}
  };

  const pumpLeakBuffer = (final) => {
    if (!_enabled) return;
    if (!leakBuffer && !final) return;
    const { emit, calls, rest } = scanLeakedToolCalls(leakBuffer, { isKnownTool: _isKnownTool, final });
    leakBuffer = rest;
    // Only text handed to the live sink counts as relayed/visible. Without
    // an onTextDelta sink the scrubbed text is buffered for the final
    // result and never shown, so it must not deny a replay.
    if (emit && onTextDelta) {
      relayedText += emit;
      try {
        onTextDelta(emit);
      } catch {}
    }
    for (const c of calls) dispatchLeakedCall(c);
  };

  return {
    get enabled() {
      return _enabled;
    },
    feedText(text) {
      if (!text) return;
      if (!_enabled) {
        if (onTextDelta) {
          relayedText += text;
          try {
            onTextDelta(text);
          } catch {}
        }
        return;
      }
      leakBuffer += text;
      pumpLeakBuffer(false);
    },
    finalize() {
      pumpLeakBuffer(true);
    },
    scrubAssistantText(raw) {
      if (!raw) return '';
      if (!_enabled) return raw;
      const { emit, calls, rest } = scanLeakedToolCalls(raw, { isKnownTool: _isKnownTool, final: true });
      for (const c of calls) dispatchLeakedCall(c);
      return emit + rest;
    },
    filterNativeToolCalls(nativeCalls) {
      if (!_enabled || !nativeCalls?.length) return nativeCalls;
      const kept = [];
      for (const call of nativeCalls) {
        const fp = toolCallFingerprint(call?.name, call?.arguments);
        if (dispatchedFingerprints.has(fp)) continue;
        dispatchedFingerprints.add(fp);
        kept.push(call);
      }
      return kept.length ? kept : undefined;
    },
    getLeakedToolCalls() {
      return leakedCalls.length ? [...leakedCalls] : [];
    },
    getRelayedText() {
      return relayedText;
    },
  };
}

// `unwrapChunk` adapts a transport that nests the Gemini payload one level
// deeper. Cloud Code Assist (Antigravity) streams `{ response: { candidates … } }`
// while the public API streams the candidates directly; everything downstream —
// aggregation, leak guard, watchdogs — stays shared.
export async function consumeGeminiRestStreamResponse(
  response,
  { signal, onStreamDelta, onTextDelta, textLeakGuard, label, unwrapChunk = null, onChunk = null }
) {
  const unwrap =
    typeof unwrapChunk === 'function'
      ? (chunk) => {
          try {
            return unwrapChunk(chunk);
          } catch {
            return chunk;
          }
        }
      : (chunk) => chunk;
  if (!response?.body) throw new Error(`${label}: missing response body`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const allChunks = [];
  let sawStreamChunk = false;
  let relayedText = '';
  let leakGuardFinalized = false;
  const finalizeLeakGuard = () => {
    if (leakGuardFinalized) return;
    leakGuardFinalized = true;
    try {
      textLeakGuard?.finalize();
    } catch {}
  };
  const watchdogs = createRestStreamWatchdogs({
    reader,
    label,
    firstByteTimeoutMs: GEMINI_FIRST_BYTE_TIMEOUT_MS,
    timeoutError: geminiTimeoutError,
  });
  // One decoded chunk: collected for aggregation and relayed to every sink.
  const relayChunk = (rawChunk) => {
    const parsed = unwrap(rawChunk);
    if (!sawStreamChunk) {
      sawStreamChunk = true;
      watchdogs.clearFirstByte();
    }
    allChunks.push(parsed);
    onChunk?.(parsed);
    try {
      onStreamDelta?.(geminiChunkProgressKind(parsed));
    } catch {}
    if (onTextDelta || textLeakGuard) {
      relayedText += relayGeminiStreamText(geminiChunkText(parsed), { onTextDelta, textLeakGuard });
    }
  };

  const onAbort = () => {
    try {
      const c = reader.cancel('aborted');
      if (c && typeof c.catch === 'function') c.catch(() => {});
    } catch {}
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    watchdogs.resetIdle();
    while (true) {
      let chunk;
      try {
        chunk = await runAbortable(signal, () => watchdogs.read(), `${label} aborted`);
      } catch (err) {
        if (watchdogs.idleTimedOut) throw watchdogs.idleError();
        if (signal?.aborted) {
          const reason = signal.reason;
          throw reason instanceof Error ? reason : new Error(`${label} aborted`);
        }
        throw err;
      } finally {
        watchdogs.clearPending();
      }
      const { done, value } = chunk;
      if (done) break;
      const drained = drainSseDataLines(buffer + decoder.decode(value, { stream: true }));
      buffer = drained.rest;
      let parsedChunks;
      try {
        // Preserve the established delivery boundary: once read()
        // returned the bytes, parse and relay them before the next
        // iteration observes cancellation.
        parsedChunks = await parseProviderJsonBatch(drained.payloads);
      } catch (cause) {
        throw geminiStreamCorruptionError(`${label} corrupt SSE JSON`, cause);
      }
      for (const rawChunk of parsedChunks) relayChunk(rawChunk);
      // Re-arm on SEMANTIC progress only. A decoded SSE payload is real
      // generation output; raw byte chunks (a partial data: line, blank
      // keepalive lines, proxy padding) are not. Resetting on every read
      // let a stalled generation that still dribbles bytes hold the idle
      // watchdog off indefinitely.
      if (parsedChunks.length) watchdogs.resetIdle();
    }
    const tail = sseDataPayload(buffer.trim());
    if (tail) {
      try {
        const [rawTail] = await parseProviderJsonBatch([tail]);
        relayChunk(rawTail);
      } catch (cause) {
        throw geminiStreamCorruptionError(`${label} corrupt SSE tail JSON`, cause);
      }
    }
  } catch (err) {
    finalizeLeakGuard();
    throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, chunks: allChunks });
  } finally {
    watchdogs.stop();
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      await reader.cancel('Gemini SSE complete');
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
    finalizeLeakGuard();
  }

  const aggregated = aggregateGeminiStreamChunks(allChunks);
  const finishReason = aggregated.candidates?.[0]?.finishReason || null;
  const promptBlockReason = aggregated.promptFeedback?.blockReason || null;
  // Truncation (no finishReason) after visible output must carry the same
  // safety stamps as an in-loop failure — assert throws OUTSIDE the catch
  // above, so stamp here too (review High: transient TRUNCATED_STREAM would
  // otherwise replay/double-render live text via withRetry).
  try {
    assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, label });
  } catch (err) {
    throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, chunks: allChunks });
  }
  return aggregated;
}

export async function consumeGeminiSdkStream(
  streamResult,
  {
    signal,
    onStreamDelta,
    onTextDelta,
    textLeakGuard,
    label,
    cancelGeneration,
    firstByteTimeoutMs = GEMINI_FIRST_BYTE_TIMEOUT_MS,
    cancellationGraceMs = 250,
  }
) {
  let relayedText = '';
  let leakGuardFinalized = false;
  const finalizeLeakGuard = () => {
    if (leakGuardFinalized) return;
    leakGuardFinalized = true;
    try {
      textLeakGuard?.finalize();
    } catch {}
  };

  const cancellation = createSdkStreamCancellation({ signal, label, cancelGeneration, cancellationGraceMs });
  const { abortError } = cancellation;
  let reader = null;
  const onSignalAbort = () => {
    const err = abortError();
    reader?.rejectPending(err);
    cancellation.cancelInFlight(err).catch(() => {});
  };
  const collectedChunks = [];

  try {
    // Observe the SDK's aggregate branch even when cancellation precedes
    // consumption: aborting the acquired request can reject both branches.
    let responsePromise;
    try {
      responsePromise = Promise.resolve(streamResult.response);
    } catch (err) {
      responsePromise = Promise.reject(err);
    }
    responsePromise.catch(() => {});
    const iterator = streamResult.stream[Symbol.asyncIterator]();
    cancellation.bindIterator(iterator);
    reader = createSdkStreamReader({
      iterator,
      label,
      firstByteTimeoutMs,
      timeoutError: geminiTimeoutError,
      cancellation,
    });
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    reader.arm();
    while (true) {
      if (signal?.aborted) throw abortError();
      if (reader.idleTimedOut) throw reader.idleError();
      let step;
      try {
        step = await reader.next();
      } catch (err) {
        if (reader.idleTimedOut) throw reader.idleError();
        if (signal?.aborted) throw abortError();
        throw normalizeGeminiSdkStreamError(err, label);
      }
      if (signal?.aborted) throw abortError();
      if (step.done) break;
      reader.noteChunk();
      if (step.value) collectedChunks.push(step.value);
      try {
        onStreamDelta?.(geminiChunkProgressKind(step.value));
      } catch {}
      if (onTextDelta || textLeakGuard) {
        const t = geminiChunkText(step.value);
        relayedText += relayGeminiStreamText(t, { onTextDelta, textLeakGuard });
      }
    }
    if (reader.idleTimedOut) throw reader.idleError();
    reader.stop();

    // SDK 0.24.1 aggregation drops thoughtSignature. Preserve wire parts
    // locally; retain the SDK response path only for an empty collection.
    let raw;
    if (collectedChunks.length > 0) {
      raw = aggregateGeminiStreamChunks(collectedChunks);
    } else {
      let response;
      try {
        response = await runAbortable(signal, () => responsePromise);
      } catch (err) {
        throw normalizeGeminiSdkStreamError(err, label);
      }
      raw = response?.candidates ? response : response?.response || response;
    }
    const finishReason = raw?.candidates?.[0]?.finishReason || null;
    const promptBlockReason = raw?.promptFeedback?.blockReason || null;
    assertGeminiStreamCompleted({ sawStreamChunk: reader.sawStreamChunk, finishReason, promptBlockReason, label });
    return raw;
  } catch (err) {
    reader?.clearFirstByte();
    const failure = signal?.aborted ? abortError() : err;
    await cancellation.cancelInFlight(failure);
    finalizeLeakGuard();
    throw stampGeminiStreamFailure(failure, { relayedText, textLeakGuard, chunks: collectedChunks });
  } finally {
    reader?.stop();
    if (signal && onSignalAbort) {
      try {
        signal.removeEventListener('abort', onSignalAbort);
      } catch {}
    }
    finalizeLeakGuard();
  }
}
