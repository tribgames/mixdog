/**
 * openai-ws-text-relay.mjs — visible text on the Responses WS stream.
 *
 * Leaked tool-call guard. The model sometimes emits a tool call as plain
 * text (XML `<invoke>`/`<function_calls>` or gpt-oss harmony
 * `<|channel|>...to=functions.NAME...<|call|>`) inside
 * `response.output_text.delta` instead of a native function_call. Text is
 * routed through the guard so leaked calls are suppressed from the visible
 * stream, synthesized (native `call_...` id shape), and dispatched like
 * native ones. Additive: the native function_call path is untouched.
 */
import { createLeakGuard } from './anthropic-leaked-toolcall.mjs';

/**
 * @param {object} deps
 * @param {ReturnType<import('./openai-ws-response-state.mjs').createWsResponseState>} deps.response
 * @param {string[] | null} deps.knownToolNames
 * @param {object | null} deps.sessionState  the caller's state object (`emittedText` lands here)
 * @param {(text: string) => void} [deps.onTextDelta]
 * @param {(kind: string) => void} [deps.onStreamDelta]
 */
export function createWsTextRelay({ response, knownToolNames, sessionState, onTextDelta, onStreamDelta }) {
  const leakGuard = createLeakGuard({ knownToolNames, harmony: true });
  const progress = (kind) => {
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  const forwardText = (text) => {
    if (!onTextDelta) return;
    if (sessionState) sessionState.emittedText = true;
    try {
      onTextDelta(text);
    } catch {}
  };
  const dispatchCalls = (calls) => {
    for (const call of calls) {
      if (response.dispatchLeakedCall(call)) progress('tool');
    }
  };
  return {
    /** A streamed output_text delta. Returns what it amounted to. */
    relay(delta) {
      if (!leakGuard.enabled) {
        response.appendText(delta || '');
        if (delta) forwardText(delta);
        if (delta) progress('text');
        return { text: !!delta, tool: false };
      }
      const { text, calls } = leakGuard.push(delta);
      if (text) {
        response.appendText(text);
        progress('text');
        forwardText(text);
      }
      dispatchCalls(calls);
      return { text: !!text, tool: calls.length > 0 };
    },
    /** Message text from the final response bundle when nothing was streamed:
     *  the same recovery, with a full flush and no live text forwarding. */
    relayFinal(text) {
      if (!leakGuard.enabled) {
        response.appendText(text || '');
        if (text) progress('text');
        return { text: !!text, tool: false };
      }
      const { text: visible, calls } = leakGuard.push(text || '', true);
      response.appendText(visible);
      if (visible) progress('text');
      dispatchCalls(calls);
      return { text: !!visible, tool: calls.length > 0 };
    },
    /** The held-back tail: legitimate trailing text is never lost. */
    flush() {
      if (!leakGuard.enabled) return;
      const { text, calls } = leakGuard.flush();
      if (text) {
        response.appendText(text);
        forwardText(text);
      }
      dispatchCalls(calls);
    },
  };
}
