/**
 * openai-http-sse-response-state/text-relay.mjs — visible text: the live
 * relay to the client, the leaked tool-call guard it runs through, and the
 * completed-output message fallback (with its citation annotations).
 *
 * The model sometimes emits a tool call as plain text (XML
 * `<invoke>`/`<function_calls>` or gpt-oss harmony
 * `<|channel|>...to=functions.NAME...<|call|>`) inside
 * `response.output_text.delta` instead of a native function_call. Text is
 * routed through the guard so leaked calls are suppressed from the visible
 * stream, synthesized (native `call_...` id shape), and dispatched like
 * native ones. Known tool names come from the request body so recovery only
 * fires for tools the model was actually offered. Additive: the native
 * function_call path is untouched.
 */
import { createLeakGuard } from '../anthropic-leaked-toolcall.mjs';
import { synthLeakedOpenAICall } from '../openai-compat-stream-common.mjs';

function pushOutputTextAnnotations(part, citations, citationKeys) {
  const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
  for (const raw of annotations) {
    const url = raw?.url || raw?.uri || raw?.href || '';
    if (!url || citationKeys.has(url)) continue;
    citationKeys.add(url);
    citations.push({
      title: raw?.title || '',
      url,
      snippet: raw?.snippet || raw?.text || raw?.description || '',
      source: 'openai-oauth',
    });
  }
}

export function createTextRelay({ state, body, onTextDelta, meaningful, emitToolCall }) {
  const relayText = (text) => {
    if (!text || !onTextDelta) return;
    state.emittedText = true;
    try {
      onTextDelta(text);
    } catch {}
  };

  const leakKnownTools = new Set(
    (Array.isArray(body?.tools) ? body.tools : [])
      .map((t) => (typeof t?.name === 'string' ? t.name : null))
      .filter(Boolean)
  );
  const leakGuard = createLeakGuard({ knownToolNames: leakKnownTools, harmony: true });
  const dispatchLeakedCall = (recovered) => {
    const call = synthLeakedOpenAICall(recovered);
    state.toolCalls.push(call);
    emitToolCall(call);
    meaningful('tool');
  };
  const relayLeakText = (delta) => {
    if (!leakGuard.enabled) {
      state.content += delta || '';
      relayText(delta);
      if (delta) meaningful('text');
      return;
    }
    const { text, calls } = leakGuard.push(delta);
    if (text) {
      state.content += text;
      meaningful('text');
      relayText(text);
    }
    for (const c of calls) dispatchLeakedCall(c);
  };
  // Flush any partial-sentinel tail held back mid-stream so legitimate
  // trailing text is never lost (streamed-text path).
  const flushLeak = () => {
    if (!leakGuard.enabled) return;
    const { text, calls } = leakGuard.flush();
    if (text) {
      state.content += text;
      relayText(text);
    }
    for (const c of calls) dispatchLeakedCall(c);
  };

  // Completed-output fallback for message text (no streamed text). Routed
  // through the leak guard so a tool call leaked only in the final bundle is
  // recovered rather than surfaced as visible content. push with final=true
  // flushes fully (no held tail). Returns whether progress was reported.
  const absorbCompletedText = (part) => {
    if (leakGuard.enabled) {
      const { text, calls } = leakGuard.push(part.text || '', true);
      state.content += text;
      if (text) meaningful('text');
      for (const c of calls) dispatchLeakedCall(c);
      return Boolean(text) || calls.length > 0;
    }
    state.content += part.text || '';
    if (part.text) meaningful('text');
    return Boolean(part.text);
  };
  const absorbCompletedMessage = (item) => {
    let reported = false;
    for (const part of item.content || []) {
      if (!state.content && part.type === 'output_text' && absorbCompletedText(part)) reported = true;
      if (part.type === 'output_text') pushOutputTextAnnotations(part, state.citations, state.citationKeys);
    }
    return reported;
  };

  return { relayLeakText, flushLeak, absorbCompletedMessage };
}
