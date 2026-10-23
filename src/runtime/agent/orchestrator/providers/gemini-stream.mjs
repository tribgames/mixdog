/**
 * gemini-stream.mjs — Gemini stream consumption (REST + SDK) and stream guards.
 *
 * Owns chunk aggregation, completion assertions,
 * timeout/truncation error shapes and the text leak guard that recovers
 * tool calls emitted as plain text.
 */
import {
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
} from '@google/generative-ai';
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_MAX_BEFORE_WARN_MS,
  providerTimeoutError,
  resolveTimeoutMs,
} from '../stall-policy.mjs';
import { knownToolNameSet, scanLeakedToolCalls, toolCallFingerprint } from './lib/leaked-toolcall.mjs';
import { traceHash, stableTraceStringify } from './trace-utils.mjs';
import { parseGeminiTextPartMetadata } from './gemini-schema.mjs';
import { parseProviderJsonBatch } from './stream-json-pool.mjs';
import { runAbortable } from '../../../shared/abort-race.mjs';
import { createSdkStreamCancellation } from './gemini-sdk-stream/cancellation.mjs';
import { createSdkStreamReader } from './gemini-sdk-stream/reader.mjs';
import { createRestStreamWatchdogs } from './gemini-rest-stream/watchdogs.mjs';
import { drainSseDataLines, sseDataPayload } from './gemini-rest-stream/sse-lines.mjs';
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import {
  applyGeminiErrorContract,
  assertNoGeminiInBandError,
  geminiFinishReasonKind,
} from './gemini-error-contract.mjs';

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

// The SDK's own base error class. Its subclasses for an HTTP status
// (FetchError) and a cancellation (AbortError) carry typed evidence of their
// own; the bare class is what the SDK throws for everything else, and it sets
// no `name` of its own.
function isBareGoogleSdkError(err) {
  return (
    err instanceof GoogleGenerativeAIError &&
    !(err instanceof GoogleGenerativeAIFetchError) &&
    !(err instanceof GoogleGenerativeAIAbortError)
  );
}

function isGeminiSdkStreamParseError(err) {
  let cursor = err;
  const seen = new Set();
  for (let depth = 0; cursor && depth < 5 && !seen.has(cursor); depth++) {
    seen.add(cursor);
    if (cursor instanceof SyntaxError) return true;
    const message = String(cursor?.message || '');
    if (
      isBareGoogleSdkError(cursor) &&
      /(?:parse|parsing|json|unexpected token|unexpected end|unterminated)/i.test(message)
    ) {
      return true;
    }
    cursor = cursor?.cause;
  }
  return false;
}

// The SDK rethrows a network failure as a bare GoogleGenerativeAIError and
// discards the socket error with its errno, so the SDK's own fixed wording is
// the only evidence left. A failed body read is a stream cut short; a failed
// request keeps the runtime's own message (e.g. 'fetch failed') after the URL,
// which the shared transport rules already classify.
const SDK_STREAM_READ_FAILURE = '[GoogleGenerativeAI Error]: Error reading from the stream';
const SDK_FETCH_FAILURE_RE = /^\[GoogleGenerativeAI Error\]: Error fetching from \S+: ([\s\S]+)$/;

function geminiSdkTransportError(err, label) {
  if (!isBareGoogleSdkError(err)) return null;
  if (err.message === SDK_STREAM_READ_FAILURE) {
    return Object.assign(new Error(`${label} stream read failed`, { cause: err }), {
      name: 'TruncatedStreamError',
      code: 'TRUNCATED_STREAM',
      truncatedStream: true,
    });
  }
  const fetchFailure = SDK_FETCH_FAILURE_RE.exec(err.message);
  if (!fetchFailure) return null;
  return Object.assign(new Error(fetchFailure[1].trim(), { cause: err }), { name: 'GeminiSdkFetchError' });
}

/** Typed shape of any SDK failure: transport loss, corrupt stream JSON, or an RPC status. */
export function normalizeGeminiSdkError(err, label) {
  const transport = geminiSdkTransportError(err, label);
  if (transport) return transport;
  const stamped = stampGeminiRpcError(err);
  if (isGeminiSdkStreamParseError(stamped)) {
    return geminiStreamCorruptionError(`${label} corrupt SDK SSE JSON`, stamped);
  }
  if (!stamped || typeof stamped !== 'object') return stamped;
  return applyGeminiErrorContract(stamped, {
    details: stamped.details,
    errorDetails: stamped.errorDetails,
    googleStatus: stamped.geminiStatus,
    message: stamped.message,
  });
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
// `failureUsage` ({ model, normalize(usageMetadata) }) carries the last
// provider-reported usageMetadata of the dead stream to the send's accounting
// as partialUsage/partialModel; nothing is attached when none was reported.
// A caller's cancellation reason may be shared by concurrent requests, so it
// never carries this request's usage: that usage is handed to this send
// directly (the caller's awaited flow).
function stampGeminiStreamFailure(
  err,
  { relayedText = '', textLeakGuard = null, chunks = [], failureUsage = null, cancelled = false } = {}
) {
  if (!err || typeof err !== 'object') return err;
  try {
    const lastWithUsage = chunks.findLast((chunk) => chunk?.usageMetadata);
    const usage = lastWithUsage && failureUsage ? failureUsage.normalize(lastWithUsage.usageMetadata) : null;
    if (usage && cancelled) noteAbandonedUsage(usage, failureUsage.model);
    else if (usage && !err.partialUsage) {
      err.partialUsage = usage;
      err.partialModel = failureUsage.model;
    }
  } catch {
    /* best-effort */
  }
  const leaked = (textLeakGuard?.getLeakedToolCalls?.() || []).length > 0;
  const finalizedText = textLeakGuard?.getRelayedText?.();
  const visibleText = typeof finalizedText === 'string' ? finalizedText : relayedText;
  const visible = visibleText.length > 0;
  // Native functionCall chunks are only dispatched after successful stream
  // completion in gemini.mjs. Until then a reconnect is safe. Text-leaked
  // calls are dispatched while parsing and remain a hard replay boundary,
  // unless the guard holds them back (`deferToolCalls`): a held call never
  // runs when the stream fails, so a reconnect cannot double-execute it.
  const pendingTool = leaked && textLeakGuard?.defersToolCalls !== true;
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
function aggregateGeminiStreamChunks(responses, label = 'Gemini stream') {
  // An error envelope anywhere in the stream — including after STOP — fails
  // the turn instead of aggregating into a success.
  for (const response of responses) assertNoGeminiInBandError(response, label);
  const aggregatedResponse = {};
  // Candidates are keyed by their own `index`; chunks that omit it fall back
  // to the position inside that chunk's candidate list.
  const candidatesByIndex = new Map();
  for (const response of responses) {
    // Early block info must survive later chunks that carry none.
    if (response?.promptFeedback) {
      aggregatedResponse.promptFeedback = { ...aggregatedResponse.promptFeedback, ...response.promptFeedback };
    }
    if (response?.candidates) {
      response.candidates.forEach((candidate, position) => {
        const candidateIndex = Number.isInteger(candidate?.index) ? candidate.index : position;
        if (!candidatesByIndex.has(candidateIndex)) candidatesByIndex.set(candidateIndex, { index: candidateIndex });
        const aggCand = candidatesByIndex.get(candidateIndex);
        // A later chunk that omits a field never erases an earlier value.
        if (candidate.citationMetadata !== undefined) {
          aggCand.citationMetadata = mergeStreamMetadata(aggCand.citationMetadata, candidate.citationMetadata);
        }
        if (candidate.groundingMetadata !== undefined) {
          aggCand.groundingMetadata = mergeStreamMetadata(aggCand.groundingMetadata, candidate.groundingMetadata);
        }
        if (geminiFinishReasonKind(candidate.finishReason) !== 'none') aggCand.finishReason = candidate.finishReason;
        if (candidate.finishMessage !== undefined) aggCand.finishMessage = candidate.finishMessage;
        if (candidate.safetyRatings !== undefined) aggCand.safetyRatings = candidate.safetyRatings;
        if (candidate.continuationToken !== undefined) aggCand.continuationToken = candidate.continuationToken;
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
      });
    }
    if (response?.usageMetadata) aggregatedResponse.usageMetadata = response.usageMetadata;
  }
  if (candidatesByIndex.size) {
    aggregatedResponse.candidates = [...candidatesByIndex.values()].sort((a, b) => a.index - b.index);
  }
  return aggregatedResponse;
}

// GroundingMetadata / CitationMetadata arrive in pieces while streaming and
// are merged, not replaced: groundingChunks carry only the chunks not sent
// before (appended as-is, so groundingSupports indices stay valid); every
// other list is a de-duplicated union, nested objects merge, scalars take the
// latest value.
function mergeStreamMetadata(previous, next) {
  if (!previous) return next;
  if (!next || typeof next !== 'object') return previous;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null) continue;
    const before = previous[key];
    if (Array.isArray(value)) {
      if (key === 'groundingChunks') {
        merged[key] = [...(before || []), ...value];
      } else {
        const seen = new Set((before || []).map((item) => JSON.stringify(item)));
        merged[key] = [...(before || []), ...value.filter((item) => !seen.has(JSON.stringify(item)))];
      }
    } else if (typeof value === 'object' && before && typeof before === 'object') {
      merged[key] = { ...before, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// A stream that ends with no finishReason is unfinished, whatever it carried
// (thoughts only, an empty body, even right after a tool result); only a
// STOP that carries no text is a completed, empty answer. The one exception
// is a stream that delivered at least one whole functionCall part and no
// explicitly unfinished one: the gateway ends such a tool-use turn without a
// finishReason, and every call is intact.
function assertGeminiStreamCompleted({ sawStreamChunk, finishReason, promptBlockReason, parts, label }) {
  if (!sawStreamChunk) {
    throw geminiTruncatedStreamError(`${label} truncated: empty stream`);
  }
  if (geminiFinishReasonKind(finishReason) === 'none' && geminiFinishReasonKind(promptBlockReason) === 'none') {
    if (Array.isArray(parts) && parts.some(isCompleteFunctionCallPart) && !parts.some(isIncompleteFunctionCallPart)) return;
    throw geminiTruncatedStreamError(`${label} truncated: no finishReason`);
  }
}

// A functionCall part is whole when it names the function and its arguments
// are not still streaming in pieces.
function isIncompleteFunctionCallPart(part) {
  const call = part?.functionCall;
  if (!call) return false;
  return (
    call.willContinue === true ||
    call.will_continue === true ||
    call.partialArgs !== undefined ||
    call.partial_args !== undefined
  );
}

function isCompleteFunctionCallPart(part) {
  const call = part?.functionCall;
  if (!call || typeof call.name !== 'string' || call.name === '') return false;
  if (isIncompleteFunctionCallPart(part)) return false;
  return call.args === undefined || (call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args));
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

// The thought-summary text of a streamed chunk, relayed as reasoning and never
// mixed into the answer text.
function geminiChunkThoughtText(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    if (p && p.thought === true && typeof p.text === 'string') text += p.text;
  }
  return text;
}

function relayGeminiReasoning(chunk, onReasoningDelta) {
  if (!onReasoningDelta) return;
  const thought = geminiChunkThoughtText(chunk);
  if (!thought) return;
  try {
    onReasoningDelta(thought);
  } catch {}
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
export function createGeminiTextLeakGuard({
  knownToolNames,
  onTextDelta,
  onToolCall,
  onStreamDelta,
  deferToolCalls = false,
}) {
  const _knownTools = knownToolNameSet(knownToolNames);
  const _enabled = _knownTools.size > 0;
  const _isKnownTool = (name) => _knownTools.has(name);
  let leakBuffer = '';
  // Markdown fence / inline-code state carried across chunks: a tag inside a
  // code fence opened in an earlier chunk is an example, not a call.
  let fenceState = null;
  let relayedText = '';
  const leakedCalls = [];
  // With `deferToolCalls`, recovered calls wait here until the caller has seen
  // the response finish cleanly (releaseDeferredToolCalls); a failed response
  // never runs them.
  const deferredCalls = [];
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
    if (deferToolCalls) deferredCalls.push(call);
    else {
      try {
        onToolCall?.(call);
      } catch {}
    }
    try {
      onStreamDelta?.('tool');
    } catch {}
  };

  const pumpLeakBuffer = (final) => {
    if (!_enabled) return;
    if (!leakBuffer && !final) return;
    const { emit, calls, rest, fenceState: nextFence } = scanLeakedToolCalls(leakBuffer, {
      isKnownTool: _isKnownTool,
      final,
      fenceState,
    });
    leakBuffer = rest;
    fenceState = nextFence;
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
    get defersToolCalls() {
      return deferToolCalls === true;
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
      return [...leakedCalls];
    },
    releaseDeferredToolCalls() {
      for (const call of deferredCalls.splice(0)) {
        try {
          onToolCall?.(call);
        } catch {}
      }
    },
    getRelayedText() {
      return relayedText;
    },
  };
}

// Finalizes the guard at most once; both stream consumers reach it from
// their failure and cleanup paths.
function createLeakGuardFinalizer(textLeakGuard) {
  let finalized = false;
  return () => {
    if (finalized) return;
    finalized = true;
    try {
      textLeakGuard?.finalize();
    } catch {}
  };
}

// `unwrapChunk` adapts a transport that nests the Gemini payload one level
// deeper. Cloud Code Assist (Antigravity) streams `{ response: { candidates … } }`
// while the public API streams the candidates directly; everything downstream —
// aggregation, leak guard, watchdogs — stays shared. `firstByteTimeoutMs` is
// the wait for the first chunk once the response headers arrived.
export async function consumeGeminiRestStreamResponse(
  response,
  {
    signal,
    onStreamDelta,
    onTextDelta,
    onReasoningDelta = null,
    textLeakGuard,
    label,
    unwrapChunk = null,
    onChunk = null,
    failureUsage = null,
    firstByteTimeoutMs = GEMINI_FIRST_BYTE_TIMEOUT_MS,
  }
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
  const finalizeLeakGuard = createLeakGuardFinalizer(textLeakGuard);
  const watchdogs = createRestStreamWatchdogs({
    reader,
    label,
    firstByteTimeoutMs,
    timeoutError: geminiTimeoutError,
  });
  // One decoded chunk: collected for aggregation and relayed to every sink.
  const relayChunk = (rawChunk) => {
    // In-band errors stay top level even on a transport that nests payloads.
    assertNoGeminiInBandError(rawChunk, label);
    const parsed = unwrap(rawChunk);
    assertNoGeminiInBandError(parsed, label);
    if (!sawStreamChunk) {
      sawStreamChunk = true;
      watchdogs.clearFirstByte();
    }
    allChunks.push(parsed);
    onChunk?.(parsed);
    try {
      onStreamDelta?.(geminiChunkProgressKind(parsed));
    } catch {}
    relayGeminiReasoning(parsed, onReasoningDelta);
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
      let rawTail;
      try {
        [rawTail] = await parseProviderJsonBatch([tail]);
      } catch (cause) {
        throw geminiStreamCorruptionError(`${label} corrupt SSE tail JSON`, cause);
      }
      relayChunk(rawTail);
    }
  } catch (err) {
    finalizeLeakGuard();
    throw stampGeminiStreamFailure(err, {
      relayedText,
      textLeakGuard,
      chunks: allChunks,
      failureUsage,
      cancelled: signal?.aborted === true,
    });
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

  const aggregated = aggregateGeminiStreamChunks(allChunks, label);
  const finishReason = aggregated.candidates?.[0]?.finishReason || null;
  const promptBlockReason = aggregated.promptFeedback?.blockReason || null;
  // Truncation (no finishReason) after visible output must carry the same
  // safety stamps as an in-loop failure — assert throws OUTSIDE the catch
  // above, so stamp here too (review High: transient TRUNCATED_STREAM would
  // otherwise replay/double-render live text via withRetry).
  try {
    assertGeminiStreamCompleted({
      sawStreamChunk,
      finishReason,
      promptBlockReason,
      parts: aggregated.candidates?.[0]?.content?.parts,
      label,
    });
  } catch (err) {
    throw stampGeminiStreamFailure(err, { relayedText, textLeakGuard, chunks: allChunks, failureUsage });
  }
  return aggregated;
}

export async function consumeGeminiSdkStream(
  streamResult,
  {
    signal,
    onStreamDelta,
    onTextDelta,
    onReasoningDelta = null,
    textLeakGuard,
    label,
    cancelGeneration,
    firstByteTimeoutMs = GEMINI_FIRST_BYTE_TIMEOUT_MS,
    cancellationGraceMs = 250,
    failureUsage = null,
  }
) {
  let relayedText = '';
  const finalizeLeakGuard = createLeakGuardFinalizer(textLeakGuard);

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
        throw normalizeGeminiSdkError(err, label);
      }
      if (signal?.aborted) throw abortError();
      if (step.done) break;
      reader.noteChunk();
      assertNoGeminiInBandError(step.value, label);
      if (step.value) collectedChunks.push(step.value);
      try {
        onStreamDelta?.(geminiChunkProgressKind(step.value));
      } catch {}
      relayGeminiReasoning(step.value, onReasoningDelta);
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
      raw = aggregateGeminiStreamChunks(collectedChunks, label);
    } else {
      let response;
      try {
        response = await runAbortable(signal, () => responsePromise);
      } catch (err) {
        throw normalizeGeminiSdkError(err, label);
      }
      raw = response?.candidates ? response : response?.response || response;
      assertNoGeminiInBandError(raw, label);
    }
    const finishReason = raw?.candidates?.[0]?.finishReason || null;
    const promptBlockReason = raw?.promptFeedback?.blockReason || null;
    assertGeminiStreamCompleted({
      sawStreamChunk: reader.sawStreamChunk,
      finishReason,
      promptBlockReason,
      parts: raw?.candidates?.[0]?.content?.parts,
      label,
    });
    return raw;
  } catch (err) {
    reader?.clearFirstByte();
    const failure = signal?.aborted ? abortError() : err;
    await cancellation.cancelInFlight(failure);
    finalizeLeakGuard();
    throw stampGeminiStreamFailure(failure, {
      relayedText,
      textLeakGuard,
      chunks: collectedChunks,
      failureUsage,
      cancelled: signal?.aborted === true,
    });
  } finally {
    reader?.stop();
    if (signal) {
      try {
        signal.removeEventListener('abort', onSignalAbort);
      } catch {}
    }
    finalizeLeakGuard();
  }
}
