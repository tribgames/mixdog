/**
 * anthropic-sse-turn.mjs — what one Anthropic SSE stream assembles: text,
 * ordered thinking / native server-tool / client tool_use blocks, usage,
 * stop info, the leaked-tool-call guard, the in-flight tool-input gates, and
 * the ordered replay lists the success result and every partial failure
 * share. The stream loop (anthropic-sse.mjs) owns the socket, watchdogs and
 * framing; this wires the turn record (anthropic-sse-turn/turn-state), the
 * ordered block store (turn-blocks), the leak guard, the event folding
 * (turn-events) and the outcome projections (turn-outcome).
 */
import { createAnthropicTurnState } from './anthropic-sse-turn/turn-state.mjs';
import { createTurnBlocks } from './anthropic-sse-turn/turn-blocks.mjs';
import { createLeakGuard } from './anthropic-sse-turn/leak-guard.mjs';
import { createTurnEvents } from './anthropic-sse-turn/turn-events.mjs';
import { createTurnOutcome } from './anthropic-sse-turn/turn-outcome.mjs';

/**
 * @param {object} deps
 * @param {object|null} deps.state  the wrapper's midState (exposure flags)
 * @param {(kind: string) => void} [deps.onStreamDelta]
 * @param {(call: object) => void} [deps.onToolCall]
 * @param {(text: string) => void} [deps.onTextDelta]
 * @param {Iterable<string>} [deps.knownToolNames]
 */
export function createAnthropicSseTurn({ state, onStreamDelta, onToolCall, onTextDelta, knownToolNames }) {
  const progress = (kind) => {
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  // Live text relay: once a non-empty chunk has been relayed it cannot be
  // withdrawn, so the exposure flags are set before the callback runs.
  const relayText = (text) => {
    if (!onTextDelta) return;
    if (state) {
      state.emittedText = true;
      state.emittedTextChars = (Number(state.emittedTextChars) || 0) + text.length;
    }
    try {
      onTextDelta(text);
    } catch {}
  };
  const turn = createAnthropicTurnState();
  const blocks = createTurnBlocks();
  const leak = createLeakGuard({ turn, state, knownToolNames, onToolCall, relayText, progress });
  const events = createTurnEvents({ turn, blocks, state, leak, relayText, progress, onToolCall });
  const outcome = createTurnOutcome({ turn, blocks, state });

  return {
    ...events,
    // Stream ended: flush any held-back leaked-tool-call buffer.
    flushLeak: leak.flush,
    ...outcome,
  };
}
