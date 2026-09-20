/**
 * anthropic-sse-turn/turn-blocks.mjs — the ordered content_block store of
 * one turn: thinking, text, native server-tool and dispatched client
 * tool_use blocks keyed by provider block index, the in-flight tool-input
 * gates, and the replay projections shared by the success result and every
 * partial failure.
 */
import { isAnthropicThinkingBlock, sanitizeAnthropicReplayEntries } from '../lib/anthropic-replay-blocks.mjs';

export function createTurnBlocks() {
  // Ordered extended-thinking blocks, keyed by content_block index. Each
  // holds the accumulated thinking text + signature exactly as received so
  // it can be round-tripped verbatim on tool-continuation turns (required
  // back on tool_use turns; empty thinking + signature is valid).
  const thinking = new Map();
  // Ordered NATIVE (server-side) tool blocks, keyed by content_block index.
  // Anthropic executes these itself — they are never dispatched to the agent
  // loop as client tool calls — but they are part of the assistant turn and
  // MUST be replayed verbatim, in original block order, on a continuation
  // turn (pause_turn): a `web_search_tool_result` is only valid immediately
  // after the `server_tool_use` block that produced it.
  const nativeServerTool = new Map();
  // Streamed `input` JSON for native server-tool CALL blocks (same
  // input_json_delta transport as client tool_use, separate index space).
  const pendingNativeToolInputs = new Map();
  const pendingToolInputs = new Map();
  // In-flight tool INPUT state: a client `tool_use` (pendingToolInputs) or an
  // Anthropic-native `server_tool_use` (pendingNativeToolInputs) whose
  // streamed input_json has not reached content_block_stop. While either is
  // non-empty the assistant turn cannot be terminal: the arguments are
  // incomplete, so the call was never pushed and never dispatched.
  const toolInputInFlight = () => pendingToolInputs.size > 0 || pendingNativeToolInputs.size > 0;
  // Per-index raw text, kept only so the ordered native-block replay list
  // can interleave text exactly where the provider emitted it.
  const text = new Map();
  const appendText = (index, chunk) => {
    text.set(index, (text.get(index) || '') + (chunk || ''));
  };
  // Client tool_use blocks that were actually dispatched, kept for the same
  // ordered replay list (deduped/skipped calls are intentionally absent).
  const clientToolUse = new Map();

  // --- ordered replay lists -------------------------------------------------
  // Shared by the SUCCESS return and the truncation/stall failures so a
  // cut-off turn preserves exactly the same completed native/client blocks
  // (verbatim, in original content_block order) that a successful turn would
  // have replayed.
  // A native CALL block is seeded at content_block_start and only gains its
  // parsed `input` at content_block_stop, so a block whose input JSON is
  // still streaming is INCOMPLETE and must never enter the replay list: it
  // would be replayed with empty/partial arguments. Completed blocks only.
  const completedNativeBlocks = () =>
    [...nativeServerTool.entries()].filter(([index]) => !pendingNativeToolInputs.has(index));
  // Every block of this turn in provider content_block index space, EMPTY
  // text blocks included. They never reach the wire (the API rejects an empty
  // text block outright), but the reducer has to see them: an empty text
  // block between two thinking blocks is the only evidence that the model
  // produced two SEPARATE thinking runs, and silently fusing those runs is a
  // permanent 400 on every later request (anthropic-replay-blocks.mjs).
  const replayEntries = () => [
    ...thinking.entries(),
    ...[...text.entries()].map(([index, value]) => [
      index,
      { type: 'text', text: typeof value === 'string' ? value : '' },
    ]),
    ...completedNativeBlocks(),
    ...clientToolUse.entries(),
  ];
  let mergedThinkingDropped = 0;
  const noteReplayDrop = (kind, block) => {
    if (kind !== 'merged_thinking') return;
    mergedThinkingDropped += 1;
    if (mergedThinkingDropped > 1) return;
    try {
      process.stderr.write(
        `[anthropic] dropped a ${block?.type || 'thinking'} block separated only by an empty ` +
          'text block; replaying it would merge two thinking runs into one\n'
      );
    } catch {
      /* best-effort */
    }
  };
  const orderedThinkingBlocks = () => {
    if (!thinking.size) return undefined;
    const kept = sanitizeAnthropicReplayEntries(replayEntries(), noteReplayDrop).filter(isAnthropicThinkingBlock);
    return kept.length ? kept : undefined;
  };
  // `dispatchedToolCalls` is the count of client calls the turn pushed; a
  // leaked plain-text tool call has no provider content_block index, so when
  // the counts differ falling back to the legacy flattened projection is
  // safer than claiming an exact replay while silently omitting that
  // synthetic call.
  const orderedAssistantBlocks = (dispatchedToolCalls) => {
    const entries = replayEntries();
    if (!entries.length) return undefined;
    if (dispatchedToolCalls > 0 && clientToolUse.size !== dispatchedToolCalls) return undefined;
    const blocks = sanitizeAnthropicReplayEntries(entries, noteReplayDrop);
    return blocks.length ? blocks : undefined;
  };

  return {
    thinking,
    nativeServerTool,
    pendingNativeToolInputs,
    pendingToolInputs,
    clientToolUse,
    appendText,
    toolInputInFlight,
    orderedThinkingBlocks,
    orderedAssistantBlocks,
  };
}
