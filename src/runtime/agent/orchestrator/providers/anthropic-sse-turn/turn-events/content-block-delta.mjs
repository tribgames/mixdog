/**
 * turn-events/content-block-delta.mjs — content_block_delta: text deltas
 * (ordered replay copy + live relay through the leak guard), thinking /
 * signature deltas and streamed tool input_json for client and native
 * server tools.
 */
export function createContentBlockDelta({ turn, blocks, state, leak, relayText, progress, relayProgressUpdates }) {
  // Under thinking.display "updates" reasoning blocks stream no text, so any
  // thinking text is a progress update (tool preamble). It is shown live like
  // preamble text but stays only in its thinking block: turn.content and the
  // replayed blocks remain exactly what the model produced.
  let progressIndex = null;
  let relayedProgress = false;
  const relayProgressUpdate = (index, text) => {
    const lead = index !== progressIndex && (relayedProgress || turn.content) ? '\n\n' : '';
    progressIndex = index;
    relayedProgress = true;
    relayText(lead + text);
    progress('text');
  };

  const onTextDelta = (index, text) => {
    // Ordered verbatim text for native-block replay — independent of the
    // leak-guard's visible-stream bookkeeping (which may hold text back).
    blocks.appendText(index, text);
    // Live text relay (gateway): forward the explicit text chunk.
    // thinking/signature/input_json deltas intentionally stay off this path.
    // Invariant: once a non-empty chunk has been relayed live it cannot be
    // withdrawn, so flag the attempt so the mid-stream retry loop treats any
    // later failure as final (a retry would concatenate attempts).
    if (leak.enabled) {
      // Route text through the leaked-tool-call guard. It appends to
      // `content`, forwards visible text via onTextDelta, and
      // synthesizes/dispatches any recovered known-tool call — suppressing
      // the tags from the visible stream.
      leak.feed(text);
      return;
    }
    turn.content += text || '';
    if (text) {
      relayText(text);
      progress('text');
    }
  };

  const onThinkingDelta = (index, delta) => {
    // Only actual reasoning TEXT counts as exposed reasoning. An empty
    // thinking block (a signature-only delta from a display-omitted model)
    // shows the user nothing, so it must not deny a replay.
    if (state && delta.type === 'thinking_delta' && delta.thinking) {
      state.emittedThinking = true;
    }
    // Extended-thinking block: provider reasoning without user-visible text.
    // Track presence so a final turn that emitted ONLY thinking (no
    // text_delta, no tool_use) can be classified by the loop as
    // synthesis-stalled rather than silent empty.
    turn.hasThinkingContent = true;
    // Accumulate the block content in order so it can be returned intact and
    // round-tripped on the next turn. A signature_delta may arrive before any
    // thinking_delta seeded the slot (display-omitted models emit only a
    // signature) — lazily create it.
    let tb = blocks.thinking.get(index);
    if (!tb) {
      tb = { type: 'thinking', thinking: '', signature: '' };
      blocks.thinking.set(index, tb);
    }
    if (delta.type === 'thinking_delta') {
      tb.thinking += delta.thinking || '';
      if (relayProgressUpdates && delta.thinking) relayProgressUpdate(index, delta.thinking);
    } else {
      tb.signature += delta.signature || '';
    }
    if ((delta.type === 'thinking_delta' && delta.thinking) || (delta.type === 'signature_delta' && delta.signature)) {
      progress('reasoning');
    }
  };

  const onInputJsonDelta = (index, partialJson) => {
    if (blocks.pendingNativeToolInputs.has(index)) {
      blocks.pendingNativeToolInputs.set(index, blocks.pendingNativeToolInputs.get(index) + (partialJson || ''));
      progress('tool');
    }
    if (state) state.partialToolCall = true;
    const pending = blocks.pendingToolInputs.get(index);
    if (pending) {
      pending.inputJson += partialJson || '';
    }
    progress('tool');
  };

  return (index, delta) => {
    if (delta?.type) turn.contentBlockTypes.add(delta.type);
    // Time-to-first-token: stamp the first content delta (text / thinking /
    // tool input_json) exactly once so the SSE trace can separate first-byte
    // latency from total stream/generation time.
    if (state && !state.ttftAt) state.ttftAt = Date.now();
    if (delta?.type === 'text_delta') onTextDelta(index, delta.text);
    if (delta?.type === 'thinking_delta' || delta?.type === 'signature_delta') onThinkingDelta(index, delta);
    if (delta?.type === 'input_json_delta') onInputJsonDelta(index, delta.partial_json);
  };
}
