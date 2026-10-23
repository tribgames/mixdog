/**
 * antigravity-stream.mjs — what one Antigravity SSE turn accumulates while it
 * streams: the live text mirror a retirement notice is recognised from, the
 * leak guard that recovers calls the model wrote as text (held back, like the
 * native calls, until the turn finishes cleanly), and the first terminal
 * finishReason. Nothing is dispatched while streaming.
 *
 * The transport (antigravity-transport.mjs) owns the socket and the retry
 * policy; the projection (antigravity-response.mjs) reads this record after
 * the turn settles.
 */
import { createGeminiTextLeakGuard, consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { normalizeAntigravityUsage } from './antigravity-response.mjs';

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
 * @param {Function|null} [deps.onReasoningDelta]  receives thought-summary text
 * @param {Function|null} [deps.retractReasoning]  drops thinking a dead attempt already showed
 */
export function createAntigravityStreamCollector({
  tools,
  useModel,
  onToolCall,
  onTextDelta,
  onStreamDelta,
  onReasoningDelta = null,
  retractReasoning = null,
}) {
  let textLeakGuard = null;
  let terminalFailure = null;
  // Streamed text is kept so a retirement notice can be told apart from
  // a truncated stream when the gateway omits the finishReason.
  let streamedText = '';

  const relayText = onTextDelta
    ? (text) => {
        if (typeof text === 'string') streamedText += text;
        onTextDelta(text);
      }
    : null;
  // Tool calls (native and text-recovered) are never dispatched while the
  // stream runs: the turn's terminal verdict decides, and
  // finalizeAntigravityTurn releases them only after a clean finish.
  const onChunk = (chunk) => {
    const candidate = chunk?.candidates?.[0];
    const finishReason =
      candidate?.finishReason ||
      (chunk?.promptFeedback?.blockReason ? `PROMPT_${chunk.promptFeedback.blockReason}` : null);
    if (finishReason && String(finishReason).replace(/^FINISH_REASON_/, '') !== 'STOP') {
      terminalFailure ||= finishReason;
    }
  };

  // Each attempt starts from an empty record: a replayed request must not
  // inherit the dead attempt's text or failure.
  const beginAttempt = () => {
    retractReasoning?.();
    textLeakGuard = createGeminiTextLeakGuard({
      knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
      onTextDelta: relayText,
      onToolCall,
      onStreamDelta,
      deferToolCalls: true,
    });
    streamedText = '';
    terminalFailure = null;
  };
  const releaseGuard = () => {
    textLeakGuard = null;
  };

  const consume = async (res, attemptSignal, { firstByteTimeoutMs } = {}) => {
    try {
      return await consumeGeminiRestStreamResponse(res, {
        signal: attemptSignal,
        firstByteTimeoutMs,
        onStreamDelta,
        onTextDelta: relayText,
        onReasoningDelta,
        onChunk,
        textLeakGuard,
        label: 'Antigravity streamGenerateContent',
        failureUsage: { model: useModel, normalize: normalizeAntigravityUsage },
        // Cloud Code Assist nests the Gemini payload under
        // `response`; in-band error events stay top level.
        unwrapChunk: (chunk) => (chunk && typeof chunk === 'object' && chunk.response ? chunk.response : chunk),
      });
    } catch (streamErr) {
      throw retiredModelError(streamErr, streamedText, useModel) || streamErr;
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
  };
}
