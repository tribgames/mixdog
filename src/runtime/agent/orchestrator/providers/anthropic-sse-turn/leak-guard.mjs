/**
 * anthropic-sse-turn/leak-guard.mjs — the leaked tool-call guard. The model
 * (esp. Opus via OAuth) occasionally emits a tool call as plain text tags
 * inside `text_delta` instead of a native `tool_use` block. The guard keeps
 * a minimal rolling window that only holds back text when a partial
 * sentinel prefix is present, so a tag split across chunk boundaries is
 * still detected while ordinary text still streams promptly. It is
 * additive: the native tool_use path is untouched.
 */
import { randomBytes } from 'node:crypto';
import { scanLeakedToolCalls, createToolCallDedupe, knownToolNameSet } from '../anthropic-leaked-toolcall.mjs';

export function createLeakGuard({ turn, state, knownToolNames, onToolCall, relayText, progress }) {
  const knownTools = knownToolNameSet(knownToolNames);
  const enabled = knownTools.size > 0;
  const isKnownTool = (name) => knownTools.has(name);
  let buffer = '';
  // Running markdown fence/inline-code state threaded across text_delta
  // chunks: a tool-call tag inside a ```code fence``` or inline span is a doc
  // example, not a real call — the guard emits it as text.
  let fenceState;
  // Cross-path fingerprint dedupe: a synthesized text-leaked call and an
  // identical native tool_use block must dispatch onToolCall exactly once.
  const dedupe = createToolCallDedupe();
  // Synthesize + dispatch a recovered leaked call exactly like the native
  // content_block_stop path (push into toolCalls, flag state, eager
  // onToolCall). A generated id uses the same `toolu_`-prefixed shape as
  // Anthropic's native tool-call ids.
  const dispatchLeakedCall = (recovered) => {
    let args = recovered?.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
    // Skip if an identical native (or prior synthetic) call already fired.
    if (!dedupe.shouldDispatch(recovered.name, args)) return;
    const call = {
      id: `toolu_leaked_${randomBytes(8).toString('hex')}`,
      name: recovered.name,
      arguments: args,
    };
    turn.toolCalls.push(call);
    if (state) state.emittedToolCall = true;
    try {
      onToolCall?.(call);
    } catch {}
    progress('tool');
  };
  // Feed accumulated text through the scanner. On `final` nothing is held
  // back so legitimate text is never lost at stream end.
  const pump = (final) => {
    if (!enabled) return;
    if (!buffer && !final) return;
    const scanned = scanLeakedToolCalls(buffer, { isKnownTool, final, fenceState });
    buffer = scanned.rest;
    fenceState = scanned.fenceState;
    if (scanned.emit) {
      turn.content += scanned.emit;
      progress('text');
      relayText(scanned.emit);
    }
    for (const c of scanned.calls) dispatchLeakedCall(c);
  };

  return {
    enabled,
    dedupe,
    // A partial sentinel is held in the buffer until the next chunk.
    feed: (text) => {
      buffer += text || '';
      pump(false);
    },
    // Stream ended: `final` holds nothing back, so a trailing partial
    // sentinel that never resolved into a real call is surfaced as ordinary
    // text — legitimate user-visible content is never lost on the failure path.
    flush: () => pump(true),
  };
}
