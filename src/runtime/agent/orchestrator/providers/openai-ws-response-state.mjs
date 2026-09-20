/**
 * openai-ws-response-state.mjs — what one Responses WS stream accumulates
 * before it settles: text, ids, tool calls (native, custom, tool_search,
 * leaked), response items for replay, citations, reasoning items, and the
 * tool-in-flight flag the stall gates read.
 *
 * The stream loop (openai-ws-stream.mjs) owns the socket, the timers and the
 * event switch; this owns the data those events fold into. The collections
 * live under openai-ws-response-state/; this file keeps the scalar state and
 * the per-event folds.
 */
import { createReplayItems } from './openai-ws-response-state/replay-items.mjs';
import { createCitations } from './openai-ws-response-state/citations.mjs';
import { createWsToolCalls } from './openai-ws-response-state/tool-calls.mjs';
import { normalizeWsUsage } from './openai-ws-response-state/usage.mjs';

export { parseToolSearchArgs } from './openai-ws-response-state/tool-calls.mjs';

/**
 * @param {object} deps
 * @param {(call: object) => void} [deps.onToolCall]
 * @param {(kind: string) => void} [deps.onStreamDelta]
 * @param {object} deps.midState  shared retry-classifier flags
 * @param {string} deps.traceProvider
 */
export function createWsResponseState({ onToolCall, onStreamDelta, midState, traceProvider }) {
  let content = '';
  let model = '';
  let responseId = '';
  let responseServiceTier = '';
  let usage;
  let stopReason = null;
  let incompleteReason = null;
  // Normalized wire `end_turn` from the terminal frame; stays undefined
  // unless the server actually supplied a boolean.
  let endTurn;
  const reasoningDeltas = { text: 0, summary: 0, other: 0 };
  const replayItems = createReplayItems();
  const citations = createCitations();
  const tools = createWsToolCalls({ onToolCall, midState, replayItems });
  const replayProvider = traceProvider === 'xai' ? 'xai-responses' : 'openai-responses';
  const progress = (kind) => {
    try {
      onStreamDelta?.(kind);
    } catch {}
  };

  // One item of the final response.completed.output bundle: salvage for
  // anything the per-item events never carried. Returns whether any progress
  // was reported.
  function salvageCompletedItem(item, relayFinalText) {
    replayItems.push(item);
    let reported = false;
    if (item.type === 'message') {
      // Completed-output fallback (no streamed text). Route through the leak
      // guard so a tool call leaked only in the final bundle is recovered, not
      // surfaced as visible content.
      const relayText = !content;
      for (const c of item.content || []) {
        if (c.type !== 'output_text') continue;
        if (relayText) {
          const relayed = relayFinalText(c.text || '');
          if (relayed.text || relayed.tool) reported = true;
        }
        citations.pushOutputTextAnnotations(c);
      }
    }
    if (item.type === 'web_search_call') {
      citations.pushWebSearchCall(item);
      progress('tool');
      reported = true;
    }
    if (item.type === 'tool_search_call') {
      tools.pushToolSearchCall(item);
      progress('tool');
      reported = true;
    }
    if (item.type === 'custom_tool_call') {
      tools.pushCustomToolCall(item);
      progress('tool');
      reported = true;
    }
    // Some streams emit reasoning only inside the final bundle (no per-item
    // .done event). Dedup by id.
    if (item.type === 'reasoning' && !replayItems.hasReasoning(item.id)) {
      replayItems.pushReasoning(item);
      progress('reasoning');
      reported = true;
    }
    if (item.type === 'function_call') {
      tools.salvageFunctionCall(item);
      progress('tool');
      reported = true;
    }
    return reported;
  }

  return {
    get content() {
      return content;
    },
    get model() {
      return model;
    },
    get toolInFlight() {
      return tools.inFlight;
    },
    get toolCallCount() {
      return tools.calls.length;
    },
    get endTurn() {
      return endTurn;
    },
    get pendingToolUse() {
      return tools.pendingToolUse;
    },
    get pendingToolInput() {
      return tools.pendingToolInput;
    },
    get toolCallsStarted() {
      return tools.started;
    },
    appendText(text) {
      content += text;
    },
    dispatchLeakedCall: tools.dispatchLeakedCall,
    countReasoningDelta(kind) {
      if (kind === 'text') reasoningDeltas.text += 1;
      else if (kind === 'summary') reasoningDeltas.summary += 1;
      else reasoningDeltas.other += 1;
    },
    /** Suppressed reasoning deltas seen so far; null when there were none. */
    reasoningDeltaSummary() {
      const total = reasoningDeltas.text + reasoningDeltas.summary + reasoningDeltas.other;
      if (total === 0) return null;
      return { total, ...reasoningDeltas };
    },
    /** response.created */
    noteCreated(response) {
      if (response?.model) model = response.model;
      if (response?.id) responseId = response.id;
    },
    /** response.output_item.added */
    noteItemAdded: tools.noteItemAdded,
    /** response.function_call_arguments.delta / custom_tool_call_input.delta */
    noteToolInputDelta: tools.noteToolInputDelta,
    /** response.function_call_arguments.done */
    completeFunctionCallArguments: tools.completeFunctionCallArguments,
    /** response.output_item.done. Returns the progress kind to report. */
    completeOutputItem(item) {
      replayItems.push(item);
      const type = item?.type || '';
      // function_call / output_text already arrive via their dedicated
      // streaming events; `reasoning` carries encrypted_content that keeps the
      // openai-oauth server-side prompt cache prefix warm.
      if (type === 'reasoning') replayItems.pushReasoning(item);
      if (type === 'web_search_call') citations.pushWebSearchCall(item);
      if (type === 'function_call') tools.completeFunctionCallItem(item);
      if (type === 'tool_search_call') tools.completeToolSearchItem(item);
      if (type === 'custom_tool_call') tools.completeCustomToolItem(item);
      if (type === 'reasoning') return 'reasoning';
      if (tools.inFlight || /tool|function_call/.test(type)) return 'tool';
      return 'semantic';
    },
    /** response.completed: usage, service tier, and the final output bundle.
     *  `relayFinalText` folds message text through the leak guard when no
     *  text was streamed. Returns whether any bundle progress was reported. */
    noteCompleted(response, relayFinalText) {
      const completedServiceTier = response?.service_tier || response?.serviceTier || '';
      if (completedServiceTier) responseServiceTier = String(completedServiceTier);
      if (response?.usage) usage = normalizeWsUsage(response.usage, responseServiceTier);
      if (!model && response?.model) model = response.model;
      if (!responseId && response?.id) responseId = response.id;
      if (!response?.output) return false;
      let reported = false;
      for (const item of response.output) {
        if (salvageCompletedItem(item, relayFinalText)) reported = true;
      }
      return reported;
    },
    /** A deferred call still missing id/name after salvage, if any. */
    unresolvedDeferredCall: tools.unresolvedDeferredCall,
    setEndTurn(value) {
      if (typeof value === 'boolean') endTurn = value;
    },
    /** max_output_tokens maps cleanly to Anthropic's stop_reason=max_tokens. */
    markMaxOutputIncomplete(reason) {
      incompleteReason = reason;
      stopReason = 'length';
    },
    /** Streamed partial state for a stream that ended WITHOUT a terminal
     *  frame: the loop decides between partial-text failure and an explicit
     *  tool-call turn. */
    partialState() {
      return {
        partialContent: content,
        partialToolCalls: tools.calls.length ? tools.calls.slice() : undefined,
        partialProviderReplay: replayItems.replay(replayProvider),
        pendingToolUse: tools.pendingToolUse,
        partialModel: model || undefined,
      };
    },
    result() {
      return {
        content,
        model,
        reasoningItems: replayItems.reasoningItems.length ? replayItems.reasoningItems : undefined,
        responseItems: replayItems.items.length ? replayItems.items : undefined,
        providerReplay: replayItems.replay(replayProvider),
        toolCalls: tools.calls.length ? tools.dedupedList() : undefined,
        citations: citations.citations.length ? citations.citations : undefined,
        webSearchCalls: citations.webSearchCalls.length ? citations.webSearchCalls : undefined,
        usage,
        stopReason: stopReason || undefined,
        // Mirror the HTTP/SSE fallback's truncated flag for the WS path
        // (sendViaWebSocket spreads this result through to the provider
        // caller unchanged).
        ...(stopReason === 'length' && content.length > 0 ? { truncated: true } : {}),
        incompleteReason: incompleteReason || undefined,
        // Only present when the terminal frame carried the wire field.
        ...(typeof endTurn === 'boolean' ? { endTurn } : {}),
        responseId: responseId || undefined,
        serviceTier: responseServiceTier || undefined,
      };
    },
  };
}
