/**
 * anthropic-sse-turn/turn-outcome.mjs — the three ways a turn leaves the
 * stream loop: the success result, a mid-stream stall error enriched with
 * partial state, and the truncated-stream error. All three project the same
 * turn record and ordered block store, so a cut-off turn carries exactly the
 * blocks a successful one would have replayed.
 */
import { stampStreamOutcome, STREAM_TRANSPORTS } from '../lib/stream-outcome.mjs';
import { createProviderReplay } from '../lib/provider-replay.mjs';
import { anthropicFallbackProviderMetadata } from '../anthropic-server-fallback.mjs';

export function createTurnOutcome({ turn, blocks, state }) {
  const partialFields = () => ({
    partialContent: turn.content,
    partialToolCalls: turn.toolCalls.length ? turn.toolCalls.slice() : undefined,
    partialModel: turn.model || undefined,
    partialUsage: turn.usage,
    partialHasThinking: turn.hasThinkingContent,
    // A cut-off turn must carry the SAME ordered block state a successful
    // turn returns: Anthropic requires the verbatim thinking blocks
    // (signatures intact) back before tool_use on the next turn, and a
    // native server_tool_use call is only valid immediately followed by its
    // result block.
    partialThinkingBlocks: blocks.orderedThinkingBlocks(),
    partialAssistantBlocks: blocks.orderedAssistantBlocks(turn.toolCalls.length),
    partialStopReason: turn.stopReason || undefined,
  });
  const exposure = () => ({
    textEmitted: state?.emittedText === true,
    textObservedChars: turn.content.length,
    // Buffered/empty thinking blocks are not exposure; only relayed
    // reasoning text is.
    reasoningEmitted: state?.emittedThinking === true,
    toolCallsComplete: turn.toolCalls.length,
    toolCallsDispatched: state?.emittedToolCall === true ? Math.max(1, turn.toolCalls.length) : 0,
  });

  // Preserve partial state for the agent loop's recovery decision and
  // interrupted-turn persistence. Partial final text alone is not success;
  // completed tool calls and incomplete input have distinct recovery rules.
  const attachStallPartial = (err) => {
    try {
      // `toolInputInFlight()` is the single authority for "arguments never
      // finished streaming": a client tool_use OR an Anthropic NATIVE
      // server_tool_use whose input JSON is still open. A mixed turn
      // (dispatched client call, then an incomplete server_tool_use) must
      // stay a continuation failure — promoting it would report a native
      // call that never ran as part of a finished turn.
      Object.assign(err, partialFields(), { pendingToolUse: blocks.toolInputInFlight() });
    } catch {
      /* best-effort enrichment */
    }
    // Canonical stream-outcome contract. Anthropic historically attached
    // ONLY the partial-state fields above, so retry/fallback/persistence
    // consumers had to guess; the record makes terminal-vs-continuation,
    // observed text/reasoning and tool exposure explicit and fail-closed.
    try {
      stampStreamOutcome(err, {
        transport: STREAM_TRANSPORTS.SSE,
        provider: 'anthropic',
        terminalObserved: state?.sawCompleted === true,
        continuation: state?.sawCompleted !== true,
        ...exposure(),
        toolCallsStarted: state?.partialToolCall === true,
        pendingToolInput: blocks.toolInputInFlight(),
        stallObserved: true,
      });
    } catch {
      /* stamping is best-effort */
    }
    return err;
  };

  // Truncated-stream guard: the reader loop exited (EOF or break) after
  // message_start but without seeing message_stop / a tool_use stop_reason,
  // so the assistant turn was cut off mid-flight. Returning success would
  // silently surface partial content (or a partially streamed tool_use whose
  // input_json never completed) as final.
  const truncatedError = () => {
    const pendingToolUse = blocks.toolInputInFlight();
    const err = Object.assign(
      new Error(
        (turn.sawTerminalFrameWithPendingInput
          ? `Anthropic OAuth SSE stream truncated: terminal frame with incomplete tool input`
          : `Anthropic OAuth SSE stream truncated: message_start without message_stop`) +
          (pendingToolUse ? ` (pending tool_use input)` : '')
      ),
      {
        name: 'TruncatedStreamError',
        code: 'TRUNCATED_STREAM',
        truncatedStream: true,
        pendingToolUse,
        stopReason: turn.stopReason,
      }
    );
    // Completed client tool calls / native server-tool blocks captured before
    // the cut-off ride on the error so the interrupted-turn persistence path
    // keeps them; the INCOMPLETE call is absent (it was never pushed and
    // never dispatched). `partialAssistantBlocks` is the SAME ordered list
    // the success path returns as `assistantBlocks`.
    try {
      Object.assign(err, partialFields());
      err.partialProviderReplay = createProviderReplay('anthropic', err.partialAssistantBlocks);
    } catch {
      /* best-effort enrichment */
    }
    // Truncation is a continuation, never a terminal turn. A pending
    // tool_use input alone stays replay-safe (nothing was dispatched);
    // exposed text/reasoning or a complete tool call is not.
    try {
      stampStreamOutcome(err, {
        transport: STREAM_TRANSPORTS.SSE,
        provider: 'anthropic',
        terminalObserved: false,
        continuation: true,
        truncatedStream: true,
        ...exposure(),
        toolCallsStarted: state?.partialToolCall === true && turn.toolCalls.length > 0,
        pendingToolInput: pendingToolUse,
      });
    } catch {
      /* stamping is best-effort */
    }
    return err;
  };

  const result = () => {
    const assistantBlocks = blocks.orderedAssistantBlocks(turn.toolCalls.length);
    return {
      content: turn.content,
      model: turn.model,
      toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
      usage: turn.usage,
      stopReason: turn.stopReason,
      stopDetails: turn.stopDetails,
      hasThinkingContent: turn.hasThinkingContent,
      contentBlockTypes: Array.from(turn.contentBlockTypes),
      // Ordered extended-thinking blocks (verbatim thinking text + signature)
      // for round-tripping on tool-continuation turns. Emitted in
      // content_block index order. Empty thinking + signature is a valid
      // block (display-omitted models) and is kept intact.
      thinkingBlocks: blocks.orderedThinkingBlocks(),
      // Complete ordered assistant content, emitted ONLY when the turn used
      // Anthropic native server tools. Those blocks cannot be reconstructed
      // from content/toolCalls/thinkingBlocks, so the loop replays this list
      // verbatim (see toAnthropicMessages' assistantBlocks branch). Absent
      // for every ordinary turn, which keeps the existing text/thinking/
      // tool_use lowering untouched.
      assistantBlocks,
      providerReplay: createProviderReplay('anthropic', assistantBlocks),
      providerMetadata: anthropicFallbackProviderMetadata(turn.fallbackEvents),
    };
  };

  return { attachStallPartial, truncatedError, result };
}
