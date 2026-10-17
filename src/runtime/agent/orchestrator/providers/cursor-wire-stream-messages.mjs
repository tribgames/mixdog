/**
 * cursor-wire-stream-messages.mjs — one decoded AgentServerMessage applied
 * to the shared stream state and relayed to the SSE sink. Returns the
 * message's forward-progress kind for the watchdog.
 */
import { randomUUID } from 'node:crypto';
import { registerCursorNativeCall } from './cursor-native-context.mjs';
import { appendAgentTrace } from '../agent-trace.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';
import { MAX_CHECKPOINT_BYTES, cursorInteractionProgress } from './cursor-wire-guards.mjs';
import { buildCursorInteractionResponse } from './cursor-wire-interactions.mjs';
import { cursorError } from './cursor-wire-transport.mjs';
import { handleExecMessage, handleKvMessage, sendClientMessage, sendToolResult } from './cursor-wire-exec.mjs';

// Unknown fields seen on every live frame: AgentServerMessage field 8 (timing
// doubles) and InteractionUpdate field 25 (epoch-ms timestamp). Never traced.
const NOISE_SERVER_FIELDS = new Set([8]);
const NOISE_UPDATE_FIELDS = new Set([25]);
const TRACE_MAX_FIELDS = 8;
const TRACE_PREVIEW_BYTES = 48;

// Records undecoded fields (number, wire type, bounded hex of the raw field)
// so a new server event such as a mid-turn model fallback can be inspected.
function traceUnknownFields(trace, sessionId, scope, unknown, noise) {
  const fields = unknown?.filter((field) => !noise.has(field.no));
  if (!fields?.length) return;
  try {
    trace({
      sessionId,
      kind: 'cursor_unknown_field',
      provider: 'cursor',
      payload: {
        scope,
        count: fields.length,
        fields: fields.slice(0, TRACE_MAX_FIELDS).map((field) => ({
          no: field.no,
          wire_type: field.wireType,
          bytes: field.data.byteLength,
          preview_hex: Buffer.from(field.data.subarray(0, TRACE_PREVIEW_BYTES)).toString('hex'),
        })),
      },
    });
  } catch {
    /* best-effort */
  }
}

// Parent edit outcomes are diagnostics, not executable calls or read results.
function traceNativeEditFailure(trace, sessionId, update) {
  const completed = update.toolCallCompleted;
  const result = completed?.toolCall?.editToolCall?.result;
  if (!result) return;
  const outcome = ['fileNotFound', 'readPermissionDenied', 'writePermissionDenied', 'rejected', 'error'].find(
    (key) => result[key] !== undefined
  );
  if (!outcome) return;
  try {
    trace({
      sessionId,
      kind: 'cursor_native_edit_failure',
      provider: 'cursor',
      payload: {
        callId: (completed.callId || '').slice(0, 256),
        modelCallId: (completed.modelCallId || '').slice(0, 256),
        outcome,
      },
    });
  } catch {
    /* best-effort */
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
function announcePendingToolCall(state, pending, emit, bridge, ownerSessionId) {
  state.executions ??= new Map();
  const executions = state.executions;
  const execId = pending.exec.execId ?? pending.exec.id;
  const previous = execId !== undefined ? executions.get(execId) : undefined;
  if (previous) {
    if (previous.completedResult) {
      sendToolResult(
        bridge,
        { ...previous, exec: pending.exec },
        previous.completedResult.result,
        previous.completedResult.ok
      );
    }
    return;
  }
  // A parent call can issue distinct executions; each needs its own local result.
  if ([...executions.values(), ...state.pending].some((entry) => entry.toolCallId === pending.toolCallId)) {
    pending.toolCallId = randomUUID();
  }
  if (execId !== undefined) executions.set(execId, pending);
  registerCursorNativeCall(ownerSessionId, pending, executions);
  state.pending.push(pending);
  // Native execs may await their result before the server completes a step.
  // The bridge hands off only after all currently received frames are whole.
  if (pending.native) state.batchBoundaryReady = true;
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
 * @param {object} ctx { state, filter, emit, conversation, tools, cloudRule, bridge, sessionId?, trace? }
 * @returns {'work'|'park'|'none'|string} progress kind for the watchdog
 */
export function processServerMessage(
  bytes,
  {
    state,
    filter,
    emit,
    conversation,
    tools,
    cloudRule,
    bridge,
    sessionId = '',
    ownerSessionId = '',
    trace = appendAgentTrace,
  }
) {
  const message = decodeMessage('AgentServerMessage', bytes);
  traceUnknownFields(trace, sessionId, 'agent_server_message', message.$unknown, NOISE_SERVER_FIELDS);
  if (message.interactionUpdate) {
    traceUnknownFields(trace, sessionId, 'interaction_update', message.interactionUpdate.$unknown, NOISE_UPDATE_FIELDS);
    traceNativeEditFailure(trace, sessionId, message.interactionUpdate);
  }
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
      announcePendingToolCall(state, pending, emit, bridge, ownerSessionId)
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
