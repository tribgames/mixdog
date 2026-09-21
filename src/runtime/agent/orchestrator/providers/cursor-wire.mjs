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
  assertCursorUserImages,
  createCursorStreamWatchdog,
  resolveCursorStreamTuning,
  storeCursorBlob,
} from './cursor-wire-guards.mjs';
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
import { handleExecMessage, heartbeatFrame, sendToolResult } from './cursor-wire-exec.mjs';
import { completionChunk, createStreamSink } from './cursor-wire-stream-sink.mjs';
import { createBridgeController } from './cursor-wire-stream-bridge.mjs';

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

// Stream state shared by the sink, the message router and the bridge controller.
function freshStreamState(sawTurnEnded) {
  return {
    outputTokens: 0,
    contextTokens: null,
    pending: [],
    closed: false,
    sawEnd: false,
    sawTurnEnded: sawTurnEnded === true,
    chunkSeq: 0,
    batchBoundaryChunkSeq: -1,
    batchBoundaryReady: false,
    visibleOutput: false,
  };
}

// The OpenAI-shaped SSE response over one live Cursor run. The bridge
// controller (cursor-wire-stream-bridge.mjs) owns frames, restarts and the
// pending tool-batch hand-off; the sink (cursor-wire-stream-sink.mjs) owns
// the chunks the caller reads.
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
  // The bridge currently feeding the stream; a restart swaps it in place.
  const live = { bridge, heartbeat };
  let watchdog = null;
  let cancelled = false;
  const runs = { get: (runKey) => activeRuns.get(runKey), store: storeActiveRun, forget: forgetActiveRun };
  const stream = new ReadableStream({
    start(controller) {
      const filter = thinkingFilter();
      const state = freshStreamState(sawTurnEnded);
      const tuning = resolveCursorStreamTuning();
      watchdog = createCursorStreamWatchdog({
        idleTimeoutMs: tuning.idleTimeoutMs,
        parkTimeoutMs: tuning.parkTimeoutMs,
        onTimeout: (kind) => {
          live.bridge.close(
            cursorError(
              kind === 'park'
                ? 'Cursor stream parked on an unanswered server request'
                : 'Cursor stream made no forward progress',
              { code: kind === 'park' ? 'stream_park_timeout' : 'stream_idle_timeout' }
            )
          );
        },
      });
      const sink = createStreamSink({ controller, id, model, filter, watchdog, state });
      const bridges = createBridgeController({
        live,
        state,
        filter,
        watchdog,
        sink,
        tuning,
        run: { key, conversation, tools, cloudRule, modelParameters, maxMode, sessionId },
        runs,
        restart,
        isCancelled: () => cancelled,
      });
      bridges.attach(bridge, heartbeat);
    },
    cancel(reason) {
      cancelled = true;
      watchdog?.stop();
      clearInterval(live.heartbeat);
      const active = activeRuns.get(key);
      if (active?.bridge === live.bridge) forgetActiveRun(key, active);
      live.bridge.close(reason instanceof Error ? reason : new Error('Cursor stream cancelled'));
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
    sendToolResult(active.bridge, pending, payload, result.isError !== true);
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
