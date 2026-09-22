/**
 * antigravity-stream.mjs — what one Antigravity SSE turn accumulates while it
 * streams: the live text mirror a retirement notice is recognised from, the
 * ordered parts of every chunk, the native tool calls parsed per chunk with
 * their id dedup, the leak guard that recovers calls the model wrote as text,
 * the first terminal finishReason, and the exposure marks a failed stream must
 * carry (emittedToolCall / unsafeToRetry / partial calls + partial replay).
 *
 * The transport (antigravity-transport.mjs) owns the socket and the retry
 * policy; the projection (antigravity-response.mjs) reads this record after
 * the turn settles.
 */
import { createProviderReplay } from './lib/provider-replay.mjs';
import { createGeminiTextLeakGuard, consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { parseToolCalls, emitGeminiToolCalls } from './gemini-schema.mjs';

// A retired wire id answers with one plain-text notice and no finishReason.
// That is a terminal answer about the model, not a truncated stream.
const RETIRED_MODEL_NOTICE = /\bno longer (?:available|supported)\b/i;

function retiredModelError(err, streamedText, model) {
  if (!(err?.code === 'TRUNCATED_STREAM' && /no finishReason/.test(String(err?.message || '')))) return null;
  const text = String(streamedText || '').trim();
  if (!RETIRED_MODEL_NOTICE.test(text)) return null;
  return Object.assign(new Error(`Antigravity retired ${model}: ${text}`), {
    code: 'MODEL_RETIRED',
    status: 404,
    httpStatus: 404,
    unsafeToRetry: true,
    modelRetired: true,
  });
}

/**
 * @param {object} deps
 * @param {Array<object>|undefined} deps.tools  offered tools (leak-guard vocabulary)
 * @param {string} deps.useModel  wire model id (replay context + retirement notice)
 * @param {Function|null} deps.onToolCall
 * @param {Function|null} deps.onTextDelta
 * @param {Function|null} deps.onStreamDelta
 */
export function createAntigravityStreamCollector({ tools, useModel, onToolCall, onTextDelta, onStreamDelta }) {
  let textLeakGuard = null;
  let terminalFailure = null;
  // Streamed text is kept so a retirement notice can be told apart from
  // a truncated stream when the gateway omits the finishReason.
  let streamedText = '';
  let streamedParts = [];
  let streamedNativeToolCalls = [];
  const seenNativeToolIds = new Set();
  const emittedToolIds = new Set();

  const relayText = onTextDelta
    ? (text) => {
        if (typeof text === 'string') streamedText += text;
        onTextDelta(text);
      }
    : null;
  const dispatchToolCall = onToolCall
    ? (call) => {
        // A failure already observed in this chunk must win over both
        // native calls and calls recovered from its text.
        if (terminalFailure || emittedToolIds.has(call.id)) return;
        emittedToolIds.add(call.id);
        onToolCall(call);
      }
    : null;
  const onChunk = (chunk) => {
    const candidate = chunk?.candidates?.[0];
    const finishReason =
      candidate?.finishReason ||
      (chunk?.promptFeedback?.blockReason ? `PROMPT_${chunk.promptFeedback.blockReason}` : null);
    if (finishReason && String(finishReason).replace(/^FINISH_REASON_/, '') !== 'STOP') {
      terminalFailure ||= finishReason;
    }
    if (!onToolCall) return;
    const parts = candidate?.content?.parts ?? [];
    streamedParts.push(...parts);
    if (terminalFailure || !parts.some((part) => part?.functionCall)) return;
    // Parse against the turn's parts so anonymous call IDs keep the
    // same ordinal as final parsing, even across separate SSE chunks.
    const fresh = (parseToolCalls(streamedParts) || []).filter((call) => {
      if (seenNativeToolIds.has(call.id)) return false;
      seenNativeToolIds.add(call.id);
      return true;
    });
    const calls = textLeakGuard?.enabled ? textLeakGuard.filterNativeToolCalls(fresh) : fresh;
    if (calls?.length) streamedNativeToolCalls.push(...calls);
    emitGeminiToolCalls(calls, dispatchToolCall);
  };

  // Each attempt starts from an empty record: a replayed request must not
  // inherit the dead attempt's text, parts or dispatched-call ids.
  const beginAttempt = () => {
    textLeakGuard = createGeminiTextLeakGuard({
      knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
      onTextDelta: relayText,
      onToolCall: dispatchToolCall,
      onStreamDelta,
    });
    streamedText = '';
    terminalFailure = null;
    streamedParts = [];
    streamedNativeToolCalls = [];
    seenNativeToolIds.clear();
    emittedToolIds.clear();
  };
  const releaseGuard = () => {
    textLeakGuard = null;
  };

  const consume = async (res, attemptSignal) => {
    try {
      return await consumeGeminiRestStreamResponse(res, {
        signal: attemptSignal,
        onStreamDelta,
        onTextDelta: relayText,
        onChunk,
        textLeakGuard,
        label: 'Antigravity streamGenerateContent',
        // Cloud Code Assist nests the Gemini payload under
        // `response`; in-band error events stay top level.
        unwrapChunk: (chunk) => (chunk && typeof chunk === 'object' && chunk.response ? chunk.response : chunk),
      });
    } catch (streamErr) {
      const error = retiredModelError(streamErr, streamedText, useModel) || streamErr;
      // Native calls now run before EOF. Preserve
      // their history and prohibit resampling after
      // a tool callback.
      if (emittedToolIds.size) {
        error.emittedToolCall = true;
        error.unsafeToRetry = true;
        const leaked = textLeakGuard.getLeakedToolCalls();
        error.partialToolCalls = [...streamedNativeToolCalls, ...leaked];
        const replay = createProviderReplay('antigravity', leaked.length ? [] : streamedParts);
        if (replay) replay.requestContext = { model: useModel };
        if (replay) error.partialProviderReplay = replay;
      }
      throw error;
    }
  };

  return {
    onTextDelta: relayText,
    beginAttempt,
    releaseGuard,
    consume,
    get leakGuard() {
      return textLeakGuard;
    },
    get terminalFailure() {
      return terminalFailure;
    },
    get streamedNativeToolCalls() {
      return streamedNativeToolCalls;
    },
    get emittedToolCount() {
      return emittedToolIds.size;
    },
  };
}
