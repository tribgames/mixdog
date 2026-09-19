import crypto, { createHash } from 'node:crypto';
import {
  isCursorAutoModelId,
  normalizeCursorUsage,
  normalizeParameterizedModels,
  withCanonicalAutoModels,
} from './cursor-wire-normalization.mjs';
import {
  decodeJsonValue,
  decodeMessage,
  encodeJsonValue,
  encodeMessage,
  rewriteConversationState,
} from './cursor-wire-protobuf.mjs';
import {
  MAX_CHECKPOINT_BYTES,
  assertCursorUserImages,
  createCursorStreamWatchdog,
  cursorInteractionProgress,
  isRetryableCursorStreamError,
  resolveCursorStreamTuning,
  storeCursorBlob,
} from './cursor-wire-guards.mjs';
import { buildCursorInteractionResponse } from './cursor-wire-interactions.mjs';
import { markProviderRecoveryExhausted } from './retry-classifier.mjs';
import {
  SSE_HEADERS,
  connectFrame,
  createFrameParser,
  cursorError,
  openCursorStream,
  parseEndStream,
  textEncoder,
} from './cursor-wire-transport.mjs';
import {
  buildRequestContext,
  buildToolDefinitions,
  canReuseRun,
  deterministicUuid,
  parseMessages,
  requestModelParameters,
  selectToolsForChoice,
  textContent,
} from './cursor-wire-request.mjs';
import {
  handleExecMessage,
  handleKvMessage,
  heartbeatFrame,
  sendClientMessage,
  sendToolResult,
} from './cursor-wire-exec.mjs';

export { clearModelCache, getCursorModels, getCursorUsage } from './cursor-wire-models.mjs';

const conversations = new Map();
const activeRuns = new Map();
const MEMORY_TTL_MS = 30 * 60_000;

function forgetActiveRun(key, expected = null) {
  const active = activeRuns.get(key);
  if (!active || (expected && active !== expected)) return false;
  activeRuns.delete(key);
  if (active.expiryTimer) clearTimeout(active.expiryTimer);
  delete active.expiryTimer;
  return true;
}

function storeActiveRun(key, active) {
  const prior = activeRuns.get(key);
  if (prior && prior !== active) forgetActiveRun(key, prior);
  if (active.expiryTimer) clearTimeout(active.expiryTimer);
  active.expiryTimer = setTimeout(() => {
    if (!forgetActiveRun(key, active)) return;
    clearInterval(active.heartbeat);
    active.bridge.close(new Error('Cursor pending tool batch expired'));
  }, MEMORY_TTL_MS);
  active.expiryTimer.unref?.();
  activeRuns.set(key, active);
}

// Tear down one stored run: drop it from the registry, stop its 5s heartbeat
// interval, and close the Cursor bridge it was holding open.
function closeActiveRun(key, active, error) {
  if (!forgetActiveRun(key, active)) return false;
  clearInterval(active.heartbeat);
  try {
    active.bridge.close(error);
  } catch {
    /* already closing */
  }
  return true;
}

// A pending tool batch deliberately outlives its HTTP response: the bridge and
// heartbeat stay up so the next request can resume the same Cursor run. That
// connection belongs to the session that opened it, so a session close / turn
// abort must reclaim it instead of leaving it connected until MEMORY_TTL_MS
// (30 minutes) expires.
function closeCursorRunsForSession(sessionId, reason = 'session_closed') {
  const scope = String(sessionId || '').trim();
  if (!scope) return 0;
  let closed = 0;
  for (const [key, active] of [...activeRuns]) {
    if (String(active?.sessionId || '') !== scope) continue;
    if (closeActiveRun(key, active, new Error(`Cursor run closed (${reason})`))) closed += 1;
  }
  return closed;
}

// Process-wide drain (shutdown / exit): no run may keep the daemon's Cursor
// sockets and heartbeat intervals alive past teardown.
function drainCursorRuns(reason = 'shutdown') {
  let closed = 0;
  for (const [key, active] of [...activeRuns]) {
    if (closeActiveRun(key, active, new Error(`Cursor run drained (${reason})`))) closed += 1;
  }
  return closed;
}

// Session-close / drain hooks. Both globals are shared with the openai WS pool,
// so chain the previously registered handler instead of overwriting it: whoever
// loads first stays reachable, in either import order.
const _priorCursorSessionCloseHook = globalThis.__mixdogCloseProviderConnectionsForSession;
globalThis.__mixdogCloseProviderConnectionsForSession = (sessionId, reason) => {
  try {
    _priorCursorSessionCloseHook?.(sessionId, reason);
  } finally {
    closeCursorRunsForSession(sessionId, reason);
  }
};
const _priorCursorDrainHook = globalThis.__mixdogDrainProviderConnections;
globalThis.__mixdogDrainProviderConnections = (reason) => {
  try {
    _priorCursorDrainHook?.(reason);
  } finally {
    drainCursorRuns(reason);
  }
};
process.on('exit', () => {
  drainCursorRuns('process-exit');
});

function conversationKey(messages, sessionId = '') {
  const scope = String(sessionId || '').trim();
  if (scope) {
    return createHash('sha256').update(`cursor-session:${scope}`).digest('hex').slice(0, 20);
  }
  const firstUser = messages.find((message) => message.role === 'user');
  return createHash('sha256')
    .update(`cursor:${textContent(firstUser?.content).slice(0, 300)}`)
    .digest('hex')
    .slice(0, 20);
}

function runKey(model, messages, sessionId = '') {
  return `${model}:${conversationKey(messages, sessionId)}`;
}

function getConversation(key) {
  const now = Date.now();
  for (const [storedKey, value] of conversations) {
    if (now - value.lastAccess > MEMORY_TTL_MS) conversations.delete(storedKey);
  }
  let conversation = conversations.get(key);
  if (!conversation) {
    conversation = {
      id: deterministicUuid(`cursor-conversation:${key}`),
      checkpoint: null,
      historyBlobIds: null,
      blobs: new Map(),
      lastAccess: now,
    };
    conversations.set(key, conversation);
  }
  conversation.lastAccess = now;
  return conversation;
}

function storeBlob(conversation, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const id = new Uint8Array(createHash('sha256').update(data).digest());
  storeCursorBlob(conversation.blobs, Buffer.from(id).toString('hex'), data);
  return id;
}

/** Does this history continue the prefix the stored checkpoint was measured against? */
function historyExtendsMeasuredPrefix(measured, next) {
  if (!Array.isArray(measured) || measured.length > next.length) return false;
  return measured.every((id, index) => id === next[index]);
}

function buildRunRequest({
  model,
  modelParameters = [],
  maxMode = false,
  systems,
  history,
  userText,
  userImages = [],
  tools,
  conversation,
}) {
  assertCursorUserImages(userImages);
  const requestContext = buildRequestContext(tools, systems.join('\n\n') || undefined);
  const rootPromptMessagesJson = storeHistoryBlobs(conversation, history);
  const stateBytes = rewriteConversationState(conversation.checkpoint, rootPromptMessagesJson);
  const cursorModel = isCursorAutoModelId(model) ? 'default' : model;
  return encodeMessage('AgentClientMessage', {
    runRequest: {
      conversationState: stateBytes,
      action: runAction(requestContext, userText, userImages),
      requestedModel: {
        modelId: cursorModel,
        maxMode: maxMode === true,
        parameters: modelParameters,
      },
      conversationId: conversation.id,
      // NOTE: AgentRunRequest.customSystemPrompt (field 8) is a dead
      // channel on the current cloud endpoint: the server maps it to an
      // internal `--system-prompt` agent flag its binary rejects with
      // invalid_argument (400). Send the harness once through the
      // action's requestContext.cloudRule, not through root history too.
    },
  });
}

// Stores every history entry as a blob and records the transcript the
// request sends. The checkpoint is server state measured against the
// transcript it last saw. Compaction (and rewind/edit) replaces that prefix
// instead of extending it, so carrying the checkpoint over would describe a
// conversation this request no longer sends. Start from a clean state; the
// full history travels in rootPromptMessagesJson either way.
function storeHistoryBlobs(conversation, history) {
  const rootPromptMessagesJson = [];
  const historyBlobIds = [];
  for (const entry of history) {
    const id = storeBlob(conversation, textEncoder.encode(JSON.stringify(entry)));
    rootPromptMessagesJson.push(id);
    historyBlobIds.push(Buffer.from(id).toString('hex'));
  }
  if (!historyExtendsMeasuredPrefix(conversation.historyBlobIds, historyBlobIds)) conversation.checkpoint = null;
  conversation.historyBlobIds = historyBlobIds;
  return rootPromptMessagesJson;
}

// A user message action when the turn carries text or images, else a resume.
function runAction(requestContext, userText, userImages) {
  if (!userText && !userImages.length) return { resumeAction: { requestContext } };
  const messageId = crypto.randomUUID();
  const selectedContext = {};
  if (userImages.length) {
    selectedContext.selectedImages = userImages.map((image) => ({
      uuid: crypto.randomUUID(),
      mimeType: image.mimeType,
      data: image.data,
    }));
  }
  return { userMessageAction: { requestContext, userMessage: { text: userText, messageId, selectedContext } } };
}

function thinkingFilter() {
  let buffer = '';
  let reasoning = false;
  return {
    process(delta) {
      const input = buffer + delta;
      buffer = '';
      let content = '';
      let thought = '';
      let cursor = 0;
      const tags = /<(\/?)(?:think|thinking|reasoning|thought|think_intent)\s*>/gi;
      for (const match of input.matchAll(tags)) {
        if (reasoning) thought += input.slice(cursor, match.index);
        else content += input.slice(cursor, match.index);
        reasoning = match[1] !== '/';
        cursor = match.index + match[0].length;
      }
      const rest = input.slice(cursor);
      const partial = rest.lastIndexOf('<');
      if (partial >= 0 && rest.length - partial < 18 && /^<\/?[a-z_]*$/i.test(rest.slice(partial))) {
        if (reasoning) thought += rest.slice(0, partial);
        else content += rest.slice(0, partial);
        buffer = rest.slice(partial);
      } else {
        if (reasoning) thought += rest;
        else content += rest;
      }
      return { content, reasoning: thought };
    },
    flush() {
      const value = buffer;
      buffer = '';
      return reasoning ? { content: '', reasoning: value } : { content: value, reasoning: '' };
    },
  };
}

function completionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function createPendingToolBatchResponse(active, model, key) {
  const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < active.pending.length; index += 1) {
        const pending = active.pending[index];
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify(
              completionChunk(id, model, {
                tool_calls: [
                  {
                    index,
                    id: pending.toolCallId,
                    type: 'function',
                    function: { name: pending.toolName, arguments: pending.decodedArgs },
                  },
                ],
              })
            )}\n\n`
          )
        );
      }
      controller.enqueue(
        textEncoder.encode(`data: ${JSON.stringify(completionChunk(id, model, {}, 'tool_calls'))}\n\n`)
      );
      controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
    cancel(reason) {
      if (!forgetActiveRun(key, active)) return;
      clearInterval(active.heartbeat);
      active.bridge.close(reason instanceof Error ? reason : new Error('Cursor pending tool batch cancelled'));
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

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

function createStreamResponse({
  bridge,
  heartbeat,
  conversation,
  tools,
  cloudRule,
  model,
  modelParameters = [],
  maxMode = false,
  key,
  // Owning session, carried into the stored run so a session close can find
  // and tear down the pending batch's bridge/heartbeat.
  sessionId = '',
  sawTurnEnded = false,
  restart = null,
}) {
  const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
  let currentBridge = bridge;
  let currentHeartbeat = heartbeat;
  let watchdog = null;
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      const filter = thinkingFilter();
      const state = {
        outputTokens: 0,
        contextTokens: null,
        pending: [],
        streamedTools: new Map(),
        closed: false,
        sawEnd: false,
        sawTurnEnded: sawTurnEnded === true,
        chunkSeq: 0,
        batchBoundaryChunkSeq: -1,
        batchBoundaryReady: false,
        visibleOutput: false,
      };
      let retryCount = 0;
      const tuning = resolveCursorStreamTuning();
      watchdog = createCursorStreamWatchdog({
        idleTimeoutMs: tuning.idleTimeoutMs,
        parkTimeoutMs: tuning.parkTimeoutMs,
        onTimeout: (kind) => {
          currentBridge.close(
            cursorError(
              kind === 'park'
                ? 'Cursor stream parked on an unanswered server request'
                : 'Cursor stream made no forward progress',
              { code: kind === 'park' ? 'stream_park_timeout' : 'stream_idle_timeout' }
            )
          );
        },
      });
      const send = (event) => {
        if (!state.closed) controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const finish = (reason = 'stop') => {
        if (state.closed) return;
        watchdog.stop();
        const flushed = filter.flush();
        if (flushed.reasoning) send(completionChunk(id, model, { reasoning_content: flushed.reasoning }));
        if (flushed.content) send(completionChunk(id, model, { content: flushed.content }));
        send(completionChunk(id, model, {}, reason));
        const completionTokens = state.outputTokens;
        send({
          ...completionChunk(id, model, {}),
          choices: [],
          usage: {
            completion_tokens: completionTokens,
            // Checkpoint occupancy is not per-request prompt usage
            // and supplies no cache split or billable token count.
            input_tokens_known: false,
            cache_tokens_known: false,
            context_tokens: state.contextTokens,
          },
        });
        controller.enqueue(textEncoder.encode('data: [DONE]\n\n'));
        state.closed = true;
        controller.close();
      };
      const fail = (error) => {
        if (state.closed) return;
        watchdog.stop();
        state.closed = true;
        controller.error(error instanceof Error ? error : new Error(String(error)));
      };
      const finishToolBatch = () => {
        if (state.closed || state.pending.length === 0) return;
        storeActiveRun(key, {
          bridge: currentBridge,
          heartbeat: currentHeartbeat,
          conversation,
          tools,
          cloudRule,
          modelParameters,
          maxMode,
          sessionId,
          pending: state.pending,
          sawTurnEnded: state.sawTurnEnded,
        });
        finish('tool_calls');
      };
      const emit = (fields) => send(completionChunk(id, model, fields));
      // Returns the message's forward-progress kind for the watchdog.
      const processMessage = (bytes) => {
        const message = decodeMessage('AgentServerMessage', bytes);
        if (message.interactionUpdate) return applyInteractionUpdate(message.interactionUpdate, state, filter, emit);
        if (message.kvServerMessage) {
          handleKvMessage(currentBridge, message.kvServerMessage, conversation);
          return 'work';
        }
        if (message.conversationCheckpointUpdate) {
          applyCheckpointUpdate(message.conversationCheckpointUpdate, conversation, state);
          return 'work';
        }
        if (message.execServerMessage) {
          const handled = handleExecMessage(currentBridge, message.execServerMessage, tools, cloudRule, (pending) =>
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
          sendClientMessage(currentBridge, outcome.message);
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
      };
      const recoverOrFail = (error) => {
        const retryable = isRetryableCursorStreamError(error);
        const recoveryEligible =
          !cancelled && typeof restart === 'function' && (!state.visibleOutput || conversation.checkpoint);
        const canRetry = retryCount < tuning.maxRetries && recoveryEligible && retryable;
        if (!canRetry) {
          // A fresh Cursor run owns its bounded in-place retries. Mark
          // exhaustion so the outer loop does not multiply that budget.
          // Resumed tool-result streams have no restart closure; those
          // intentionally fall through unmarked so the outer loop can
          // rebuild from the committed assistant/tool-result history.
          if (retryable && recoveryEligible && retryCount >= tuning.maxRetries) {
            markProviderRecoveryExhausted(error, {
              owner: 'cursor-wire',
              attempts: retryCount + 1,
            });
          }
          fail(error);
          return;
        }
        retryCount += 1;
        state.sawEnd = false;
        state.batchBoundaryReady = false;
        state.batchBoundaryChunkSeq = -1;
        try {
          const next = restart({
            attempt: retryCount,
            fromCheckpoint: Boolean(conversation.checkpoint),
            visibleOutput: state.visibleOutput,
          });
          attachBridge(next.bridge, next.heartbeat);
        } catch (restartError) {
          fail(restartError);
        }
      };
      const attachBridge = (nextBridge, nextHeartbeat) => {
        currentBridge = nextBridge;
        currentHeartbeat = nextHeartbeat;
        const ownedBridge = nextBridge;
        const ownedHeartbeat = nextHeartbeat;
        const frameParser = createFrameParser(
          (bytes) => {
            const progress = processMessage(bytes);
            watchdog.progress(progress);
          },
          (bytes) => {
            state.sawEnd = true;
            const error = parseEndStream(bytes);
            if (error) {
              ownedBridge.close(error);
            } else if (state.pending.length > 0) {
              // A clean end-stream is also a final tool batch delimiter.
              state.batchBoundaryReady = true;
            } else if (!state.sawTurnEnded) {
              ownedBridge.close(
                cursorError('Cursor stream ended before turnEnded', {
                  code: 'incomplete_stream',
                })
              );
            } else {
              finish();
              ownedBridge.close();
            }
          }
        );
        ownedBridge.onData((chunk) => {
          if (currentBridge !== ownedBridge || state.closed) return;
          state.chunkSeq += 1;
          try {
            frameParser(chunk);
            if (state.pending.length > 0 && state.batchBoundaryChunkSeq === state.chunkSeq) {
              state.batchBoundaryReady = true;
            }
            // Never hand a partial Connect frame to the next response parser.
            if (state.batchBoundaryReady && frameParser.bufferedBytes() === 0) {
              finishToolBatch();
            }
          } catch (error) {
            ownedBridge.close(error);
          }
        });
        ownedBridge.onClose((error) => {
          clearInterval(ownedHeartbeat);
          const active = activeRuns.get(key);
          if (active?.bridge === ownedBridge) forgetActiveRun(key, active);
          if (cancelled) return;
          if (state.closed || currentBridge !== ownedBridge) return;
          let closeError = error;
          if (!closeError) {
            try {
              frameParser.finish();
            } catch (frameError) {
              closeError = frameError;
            }
          }
          // Cursor commonly closes HTTP/2 immediately after turnEnded without
          // a separate Connect end frame. The turn is already complete.
          if (state.sawTurnEnded) {
            finish();
            return;
          }
          // Tool calls already emitted to the caller remain actionable even if
          // the parked transport vanished. The next request rebuilds/resumes.
          if (state.pending.length > 0) {
            finish('tool_calls');
            return;
          }
          if (!closeError && !state.sawEnd) {
            closeError = cursorError('Cursor stream closed before its end frame', {
              code: 'protocol_error',
            });
          }
          if (closeError) recoverOrFail(closeError);
          else finish();
        });
        watchdog.start();
      };
      attachBridge(bridge, heartbeat);
    },
    cancel(reason) {
      cancelled = true;
      watchdog?.stop();
      clearInterval(currentHeartbeat);
      const active = activeRuns.get(key);
      if (active?.bridge === currentBridge) forgetActiveRun(key, active);
      currentBridge.close(reason instanceof Error ? reason : new Error('Cursor stream cancelled'));
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function startRun(accessToken, requestBytes) {
  const bridge = openCursorStream({ accessToken });
  try {
    bridge.write(connectFrame(requestBytes));
  } catch (error) {
    bridge.close(error);
    throw error;
  }
  const heartbeat = setInterval(() => bridge.write(heartbeatFrame()), 5_000);
  heartbeat.unref?.();
  return { bridge, heartbeat };
}

function resumeRun(active, toolResults, userText, model, key) {
  const remaining = [];
  const pendingUserText = [active.pendingUserText, userText].filter(Boolean).join('\n\n');
  const lastExecId = active.pending.at(-1)?.exec?.execId;
  let userTextDelivered = false;
  for (const pending of active.pending) {
    const result = toolResults.find((entry) => entry.toolCallId === pending.toolCallId);
    if (!result) {
      remaining.push(pending);
      continue;
    }
    const payload = { ...result, content: String(result.content ?? '') };
    if (pendingUserText && pending.exec.execId === lastExecId) {
      payload.content += `\n\n<user_message>\n${pendingUserText}\n</user_message>`;
      userTextDelivered = true;
    }
    sendToolResult(active.bridge, pending, payload, Boolean(result) && result.isError !== true);
  }
  active.pending = remaining;
  active.pendingUserText = userTextDelivered ? '' : pendingUserText;
  if (remaining.length > 0) {
    storeActiveRun(key, active);
    return createPendingToolBatchResponse(active, model, key);
  }
  active.pendingUserText = '';
  return createStreamResponse({ ...active, model, key });
}

function noUserMessageResponse() {
  return new Response(JSON.stringify({ error: { message: 'No user message found' } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function supersedeActiveRun(key, active) {
  forgetActiveRun(key, active);
  clearInterval(active.heartbeat);
  active.bridge.close(new Error('Cursor run superseded'));
}

export async function handleChatCompletion(body, accessToken) {
  const parsed = parseMessages(body.messages);
  if (
    !parsed.userText &&
    parsed.userImages.length === 0 &&
    parsed.history.length === 0 &&
    parsed.toolResults.length === 0
  ) {
    return noUserMessageResponse();
  }
  const model = body.model || 'auto';
  const modelParameters = requestModelParameters(body);
  const maxMode = body.mixdog_max_mode === true;
  const sessionId = String(body.mixdog_session_id || '');
  const key = runKey(model, body.messages, sessionId);
  const selectedTools = selectToolsForChoice(body.tools, body.tool_choice);
  const toolDefinitions = buildToolDefinitions(selectedTools);
  const cloudRule = parsed.systems.join('\n\n') || undefined;
  const active = activeRuns.get(key);
  if (
    active &&
    parsed.toolResults.length &&
    active.bridge.alive &&
    canReuseRun(active, { tools: toolDefinitions, cloudRule, modelParameters, maxMode })
  ) {
    forgetActiveRun(key, active);
    return resumeRun(active, parsed.toolResults, parsed.userText, model, key);
  }
  if (active) supersedeActiveRun(key, active);
  const convKey = conversationKey(body.messages, sessionId);
  const conversation = getConversation(convKey);
  const runInput = {
    model,
    modelParameters,
    maxMode,
    systems: parsed.systems,
    history: parsed.history,
    userText: parsed.userText,
    userImages: parsed.userImages,
    tools: toolDefinitions,
    conversation,
  };
  const requestBytes = buildRunRequest(runInput);
  const { bridge, heartbeat } = startRun(accessToken, requestBytes);
  return createStreamResponse({
    bridge,
    heartbeat,
    conversation,
    tools: toolDefinitions,
    cloudRule,
    model,
    modelParameters,
    maxMode,
    key,
    sessionId,
    restart: ({ fromCheckpoint }) =>
      startRun(
        accessToken,
        fromCheckpoint ? buildRunRequest({ ...runInput, userText: '', userImages: [] }) : requestBytes
      ),
  });
}

export const __cursorWireInternals = Object.freeze({
  encodeMessage,
  decodeMessage,
  encodeJsonValue,
  decodeJsonValue,
  connectFrame,
  createFrameParser,
  createStreamResponse,
  parseEndStream,
  conversationKey,
  runKey,
  rewriteConversationState,
  handleExecMessage,
  sendToolResult,
  resumeRun,
  parseMessages,
  buildRunRequest,
  requestModelParameters,
  selectToolsForChoice,
  activeRunPendingCount: (key) => activeRuns.get(key)?.pending?.length || 0,
  normalizeCursorUsage,
  normalizeParameterizedModels,
  withCanonicalAutoModels,
});
