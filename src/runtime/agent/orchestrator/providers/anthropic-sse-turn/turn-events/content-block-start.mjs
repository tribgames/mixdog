/**
 * turn-events/content-block-start.mjs — content_block_start: seeds the ordered
 * slot for the block kind (fallback marker, client tool_use, text, native
 * server tool call/result, thinking / redacted_thinking).
 */
import {
  NATIVE_SERVER_TOOL_CALL_BLOCK_TYPES,
  NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES,
} from '../../lib/anthropic-native-blocks.mjs';
import { parseAnthropicFallbackBlock } from '../../anthropic-server-fallback.mjs';

// Detach the provider payload from the parser's event object without altering
// any field (opaque server-tool result payloads must round-trip byte-exact).
function cloneNativeBlock(block) {
  try {
    return structuredClone(block);
  } catch {
    return { ...block };
  }
}

export function createContentBlockStart({ turn, blocks, state, progress }) {
  const seedThinkingBlock = (index, block) => {
    if (block.type === 'redacted_thinking') {
      // Opaque redacted payload: real reasoning content, exposed as a block.
      if (state) state.emittedThinking = true;
      // Redacted blocks round-trip EXACTLY as {type:'redacted_thinking',data}
      // — no thinking/signature fields (the API rejects the extras). `data`
      // carries the opaque payload verbatim.
      blocks.thinking.set(index, {
        type: 'redacted_thinking',
        data: typeof block.data === 'string' ? block.data : '',
      });
      turn.hasThinkingContent = true;
      progress('reasoning');
      return;
    }
    // Seed an ordered thinking block; deltas append text + signature into
    // this same slot.
    blocks.thinking.set(index, {
      type: 'thinking',
      thinking: typeof block.thinking === 'string' ? block.thinking : '',
      signature: typeof block.signature === 'string' ? block.signature : '',
    });
  };

  return (index, block) => {
    const fallback = parseAnthropicFallbackBlock(block);
    if (fallback) {
      turn.fallbackEvents.push(fallback);
      turn.model = fallback.fallbackModel;
      turn.contentBlockTypes.add('fallback');
      progress('semantic');
    }
    if (block?.type === 'tool_use') {
      if (state) state.partialToolCall = true;
      blocks.pendingToolInputs.set(index, {
        id: block.id || '',
        name: block.name || '',
        inputJson: '',
      });
    }
    if (block?.type === 'text') {
      // Seed the ordered text slot (a text block may open with a non-empty
      // `text` before any delta).
      blocks.appendText(index, typeof block.text === 'string' ? block.text : '');
    }
    if (NATIVE_SERVER_TOOL_CALL_BLOCK_TYPES.has(block?.type)) {
      // Verbatim seed; `input` is completed from the streamed
      // input_json_delta at content_block_stop.
      blocks.nativeServerTool.set(index, cloneNativeBlock(block));
      blocks.pendingNativeToolInputs.set(index, '');
      progress('tool');
    } else if (NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES.has(block?.type)) {
      // Server-tool RESULT blocks arrive whole (no deltas); keep the payload
      // byte-for-byte for replay.
      blocks.nativeServerTool.set(index, cloneNativeBlock(block));
      progress('tool');
    }
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') seedThinkingBlock(index, block);
  };
}
