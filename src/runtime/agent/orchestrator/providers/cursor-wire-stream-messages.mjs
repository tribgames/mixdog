/**
 * cursor-wire-stream-messages.mjs — one decoded AgentServerMessage applied
 * to the shared stream state and relayed to the SSE sink. Returns the
 * message's forward-progress kind for the watchdog.
 */
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { MAX_CHECKPOINT_BYTES, cursorInteractionProgress } from './cursor-wire-guards.mjs';
import { buildCursorInteractionResponse } from './cursor-wire-interactions.mjs';
import { cursorError } from './cursor-wire-transport.mjs';
import { handleExecMessage, handleKvMessage, sendClientMessage } from './cursor-wire-exec.mjs';

// Records a streamed tool-call lifecycle event on the shared stream state.
function recordStreamedTool(state, update) {
  const { toolCallStarted, partialToolCall, toolCallDelta, toolCallCompleted } = update;
  if (toolCallStarted?.callId) {
    state.streamedTools.set(toolCallStarted.callId, {
      status: 'started',
      modelCallId: toolCallStarted.modelCallId || '',
    });
  }
  if (partialToolCall?.callId) {
    state.streamedTools.set(partialToolCall.callId, {
      status: 'partial',
      modelCallId: partialToolCall.modelCallId || '',
      argsText: partialToolCall.argsTextDelta || '',
    });
  }
  if (toolCallDelta?.callId && !state.streamedTools.has(toolCallDelta.callId)) {
    state.streamedTools.set(toolCallDelta.callId, {
      status: 'delta',
      modelCallId: toolCallDelta.modelCallId || '',
    });
  }
  if (toolCallCompleted?.callId) {
    state.streamedTools.set(toolCallCompleted.callId, {
      status: 'completed',
      modelCallId: toolCallCompleted.modelCallId || '',
    });
  }
}

// Relays one interaction update to the SSE stream and returns its progress.
function applyInteractionUpdate(update, state, filter, emit) {
  if (update.textDelta?.text) {
    const delta = filter.process(update.textDelta.text);
    if (delta.reasoning) {
      state.visibleOutput = true;
      emit({ reasoning_content: delta.reasoning });
    }
    if (delta.content) {
      state.visibleOutput = true;
      emit({ content: delta.content });
    }
  }
  if (update.thinkingDelta?.text) {
    state.visibleOutput = true;
    emit({ reasoning_content: update.thinkingDelta.text });
  }
  recordStreamedTool(state, update);
  if (update.turnEnded) {
    state.sawTurnEnded = true;
    state.batchBoundaryChunkSeq = state.chunkSeq;
  }
  if (update.stepCompleted) state.batchBoundaryChunkSeq = state.chunkSeq;
  state.outputTokens += update.tokenDelta?.tokens || 0;
  return cursorInteractionProgress(update);
}

function applyCheckpointUpdate(update, conversation, state) {
  conversation.checkpoint = update.byteLength <= MAX_CHECKPOINT_BYTES ? update : null;
  state.batchBoundaryChunkSeq = state.chunkSeq;
  try {
    const checkpoint = decodeMessage('ConversationStateStructure', conversation.checkpoint);
    state.contextTokens = checkpoint.tokenDetails?.usedTokens ?? state.contextTokens;
  } catch {}
}

// Announces a newly pending native/MCP tool call as a completion chunk once.
function announcePendingToolCall(state, pending, emit) {
  if (state.pending.some((entry) => entry.toolCallId === pending.toolCallId)) return;
  state.pending.push(pending);
  emit({
    tool_calls: [
      {
        index: state.pending.length - 1,
        id: pending.toolCallId,
        type: 'function',
        function: { name: pending.toolName, arguments: pending.decodedArgs },
      },
    ],
  });
}

/**
 * @param {Uint8Array} bytes one Connect frame payload
 * @param {object} ctx { state, filter, emit, conversation, tools, cloudRule, bridge }
 * @returns {'work'|'park'|'none'|string} progress kind for the watchdog
 */
export function processServerMessage(bytes, { state, filter, emit, conversation, tools, cloudRule, bridge }) {
  const message = decodeMessage('AgentServerMessage', bytes);
  if (message.interactionUpdate) return applyInteractionUpdate(message.interactionUpdate, state, filter, emit);
  if (message.kvServerMessage) {
    handleKvMessage(bridge, message.kvServerMessage, conversation);
    return 'work';
  }
  if (message.conversationCheckpointUpdate) {
    applyCheckpointUpdate(message.conversationCheckpointUpdate, conversation, state);
    return 'work';
  }
  if (message.execServerMessage) {
    const handled = handleExecMessage(bridge, message.execServerMessage, tools, cloudRule, (pending) =>
      announcePendingToolCall(state, pending, emit)
    );
    return handled === false ? 'park' : 'work';
  }
  if (message.interactionQuery) {
    const outcome = buildCursorInteractionResponse(message.interactionQuery);
    if (!outcome.handled) {
      throw cursorError(`Unsupported Cursor interaction query: ${outcome.queryCase}`, {
        code: 'protocol_drift',
        status: 400,
      });
    }
    sendClientMessage(bridge, outcome.message);
    return 'work';
  }
  if (message.execServerControlMessage?.abort) {
    throw cursorError('Cursor aborted the active exec', { code: 'exec_aborted', status: 400 });
  }
  if (message.$unknown?.length) {
    throw cursorError(`Unsupported Cursor server message field ${message.$unknown[0].no}`, {
      code: 'protocol_drift',
      status: 400,
    });
  }
  return 'none';
}
