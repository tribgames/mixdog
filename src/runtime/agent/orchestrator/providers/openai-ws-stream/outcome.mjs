import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';

// Canonical stream-outcome contract: ONE authoritative record of what this WS
// turn produced, stamped on every reject path (watchdog stall, abnormal close,
// server error, abort). Legacy aliases are preserved by stampStreamOutcome().
export function stampTerminalOutcome(terminalError, midState, response) {
  try {
    stampStreamOutcome(terminalError, {
      transport: STREAM_TRANSPORTS.WS,
      provider: 'openai-responses',
      terminalObserved: midState.sawCompleted === true,
      continuation: midState.sawCompleted !== true,
      textEmitted: midState.emittedText === true,
      textObservedChars: response.content.length,
      reasoningEmitted: midState.emittedReasoning === true,
      toolCallsStarted: response.toolCallsStarted,
      toolCallsComplete: response.toolCallCount,
      toolCallsDispatched: midState.emittedToolCall === true ? Math.max(1, response.toolCallCount) : 0,
      pendingToolInput: response.pendingToolInput,
      userAbort: midState.userAbort === true,
      // A terminal frame with end_turn=false keeps the same user turn open:
      // terminal observed, still continuation.
      ...(response.endTurn === false ? { continuationDeclared: true } : {}),
    });
  } catch {
    /* stamping is best-effort; aliases already set */
  }
}
