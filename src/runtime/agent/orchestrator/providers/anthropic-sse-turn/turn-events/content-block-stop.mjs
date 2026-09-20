/**
 * turn-events/content-block-stop.mjs — content_block_stop: completes a native
 * server-tool input from its streamed JSON, and finalizes a client tool_use
 * into a dispatched tool call (parsed args, leak dedupe, ordered replay copy,
 * eager dispatch).
 */
import { makeInvalidToolArgsMarker } from '../../openai-compat-stream.mjs';

const log = (line) => {
  try {
    process.stderr.write(`[anthropic-oauth] ${line}\n`);
  } catch {}
};

// Bare JSON.parse used to throw straight up into the surrounding broad catch,
// which swallowed the whole tool_call — the loop never saw it and the
// assistant turn ended with an unmatched tool_use id. A malformed input still
// produces a tool_call (with an invalid-args marker and a logged error)
// instead of a silent drop or accidental `{}` dispatch. Tool arguments must
// be a plain object: Anthropic's tool_use input is always a JSON object, but
// a malformed stream could parse to an array/string/number — wrap those as {}
// to keep the contract (invariant-based, no heuristic coercion).
function parseClientToolArgs(pending) {
  let parsedArgs = {};
  if (pending.inputJson) {
    try {
      parsedArgs = JSON.parse(pending.inputJson);
    } catch (parseErr) {
      log(`tool args JSON.parse failed (id=${pending.id}, name=${pending.name}): ${parseErr?.message || parseErr}`);
      parsedArgs = makeInvalidToolArgsMarker(
        pending.inputJson,
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      );
    }
  }
  if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    log(
      `tool args not a plain object (id=${pending.id}, name=${pending.name}, type=${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs}); using {}`
    );
    parsedArgs = {};
  }
  return parsedArgs;
}

function parseNativeToolInput(nativeBlock, rawInput) {
  let input = nativeBlock.input && typeof nativeBlock.input === 'object' ? nativeBlock.input : {};
  if (rawInput) {
    try {
      input = JSON.parse(rawInput);
    } catch (parseErr) {
      log(
        `native server-tool input JSON.parse failed (type=${nativeBlock.type}, id=${nativeBlock.id || ''}): ${parseErr?.message || parseErr}`
      );
      input = {};
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) input = {};
  return input;
}

export function createContentBlockStop({ turn, blocks, state, leak, progress, onToolCall }) {
  return (index) => {
    if (blocks.pendingNativeToolInputs.has(index)) {
      const rawInput = blocks.pendingNativeToolInputs.get(index);
      blocks.pendingNativeToolInputs.delete(index);
      const nativeBlock = blocks.nativeServerTool.get(index);
      if (nativeBlock) nativeBlock.input = parseNativeToolInput(nativeBlock, rawInput);
    }
    const pending = blocks.pendingToolInputs.get(index);
    if (!pending) return;
    const call = {
      id: pending.id,
      name: pending.name,
      arguments: parseClientToolArgs(pending),
    };
    blocks.pendingToolInputs.delete(index);
    // Skip the ENTIRE call (push + dispatch) when a text-leaked synthetic of
    // the same (name,args) already fired — otherwise the duplicate stays in
    // `toolCalls` and the loop executes the side-effecting tool twice. An
    // invalid-args marker never fingerprint-collides with a real recovered
    // call, so malformed native calls still dispatch.
    if (leak.dedupe.shouldDispatch(call.name, call.arguments, call.id)) {
      turn.toolCalls.push(call);
      // Ordered replay copy of the dispatched call — skipped/deduped calls
      // stay out so a replayed turn never carries an orphan tool_use.
      blocks.clientToolUse.set(index, {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.arguments,
      });
      if (state) state.emittedToolCall = true;
      // Eager dispatch: let the loop start this tool before message_stop
      // arrives. The loop keys pending promises by call.id so order is safe.
      try {
        onToolCall?.(call);
      } catch {}
    }
    progress('tool');
  };
}
