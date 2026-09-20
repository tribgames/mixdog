// JSONL lifecycle for `mixdog exec --json`: one event per line, mirroring the
// engine callbacks (provider requests, reasoning, assistant text, tool calls,
// tool batches, stage changes) onto a thread/turn/item event stream, closed by
// a `turn.completed|failed` pair and a `result` line.
import { randomUUID } from 'node:crypto';
import { clean } from './runtime/shared/clean.mjs';

export function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function jsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function toolCallName(call) {
  return clean(call?.name ?? call?.toolName ?? call?.function?.name ?? call?.tool?.name) || 'tool';
}

function toolCallArguments(call) {
  const raw = call?.arguments ?? call?.input ?? call?.function?.arguments ?? call?.tool?.arguments ?? call?.args ?? {};
  if (typeof raw !== 'string') return jsonValue(raw);
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { input: raw };
  }
}

function usageSummary(stats, toolCallCount = 0) {
  return {
    input_tokens: nonNegativeNumber(stats.inputTokens),
    cached_input_tokens: nonNegativeNumber(stats.cachedTokens),
    cache_write_input_tokens: nonNegativeNumber(stats.cacheWriteTokens),
    output_tokens: nonNegativeNumber(stats.outputTokens),
    tool_calls: nonNegativeNumber(toolCallCount),
  };
}

function usageDeltaSummary(delta = {}) {
  return {
    input_tokens: nonNegativeNumber(delta.deltaInput),
    cached_input_tokens: nonNegativeNumber(delta.deltaCachedRead),
    cache_write_input_tokens: nonNegativeNumber(delta.deltaCacheWrite),
    output_tokens: nonNegativeNumber(delta.deltaOutput),
  };
}

// Tool-call phase durations from the engine's timing marks, each phase falling
// back to the previous mark so a partial report still yields monotonic spans.
function toolTimingFor(entry, message, at) {
  const rawTiming = message?.toolTiming || entry.earlyTiming || {};
  const dispatchStartedAt = nonNegativeNumber(rawTiming.dispatchStartedAt || entry.startedAt);
  const executionStartedAt = nonNegativeNumber(rawTiming.executionStartedAt || dispatchStartedAt);
  const executionCompletedAt = nonNegativeNumber(rawTiming.executionCompletedAt || entry.earlyCompletedAt || at);
  const postprocessStartedAt = nonNegativeNumber(rawTiming.postprocessStartedAt || executionCompletedAt);
  const resultCompletedAt = nonNegativeNumber(rawTiming.resultCompletedAt || at);
  return {
    queue_ms: Math.max(0, dispatchStartedAt - entry.startedAt),
    dispatch_ms: Math.max(0, executionStartedAt - dispatchStartedAt),
    execution_ms: Math.max(0, executionCompletedAt - executionStartedAt),
    batch_wait_ms: Math.max(0, postprocessStartedAt - executionCompletedAt),
    postprocess_ms: Math.max(0, resultCompletedAt - postprocessStartedAt),
    total_ms: Math.max(0, resultCompletedAt - entry.startedAt),
  };
}

function toolCallStatus(message) {
  if (message?.isError === true || message?.toolKind === 'error') return 'failed';
  if (message?.toolKind === 'skipped') return 'skipped';
  return 'completed';
}

const nowIso = (value = Date.now()) => new Date(value).toISOString();

/** The stream's explicit state: resolved route, counters, the open provider
 *  request / tool batch, buffered reasoning and the tool-call ledger. */
function createStreamState({ provider, model, effort, fast, cwd, webSearch }) {
  return {
    threadId: `exec_${randomUUID().replace(/-/g, '')}`,
    turnId: 'turn_1',
    provider: clean(provider),
    model: clean(model),
    effort: clean(effort) || null,
    fast: fast === true,
    cwd: clean(cwd),
    webSearch: webSearch === true,
    started: false,
    turnStartedAt: 0,
    itemSequence: 0,
    toolCallCount: 0,
    providerRequestCount: 0,
    providerDurationMs: 0,
    activeProviderRequest: null,
    activeToolBatch: null,
    reasoningText: '',
    lastAssistantText: '',
    pendingTools: new Map(),
    completedTools: new Set(),
  };
}

function createEventWriter(write, state) {
  const emit = (event, at = Date.now()) => {
    write(`${JSON.stringify({ schema_version: 1, timestamp: nowIso(at), ...event })}\n`);
  };
  const turnEvent = (type, fields = {}, at = Date.now()) =>
    emit({ type, thread_id: state.threadId, turn_id: state.turnId, ...fields }, at);
  return {
    emit,
    turnEvent,
    itemCompleted: (item, at) => turnEvent('item.completed', { item }, at),
    nextItemId: (prefix = 'item') => `${prefix}_${++state.itemSequence}`,
  };
}

const toolCallItem = (entry, fields) => ({
  id: entry.id,
  type: 'tool_call',
  name: entry.name,
  arguments: entry.arguments,
  ...fields,
});

function startThread({ state, out }, runtime = null) {
  if (state.started) return;
  state.threadId = clean(runtime?.id) || state.threadId;
  state.provider = clean(runtime?.provider) || state.provider;
  state.model = clean(runtime?.model) || state.model;
  state.effort = clean(runtime?.effort) || state.effort;
  state.fast = runtime?.fast === true || state.fast;
  state.cwd = clean(runtime?.cwd) || state.cwd;
  state.turnStartedAt = Date.now();
  state.started = true;
  out.emit(
    {
      type: 'thread.started',
      thread_id: state.threadId,
      session: {
        provider: state.provider,
        model: state.model,
        effort: state.effort,
        fast: state.fast,
        cwd: state.cwd,
        tool_mode: 'full',
        approval_mode: 'implicit',
        delegation: false,
        web_search: state.webSearch,
      },
    },
    state.turnStartedAt
  );
  out.turnEvent('turn.started', {}, state.turnStartedAt);
}

function startProviderRequest({ state, out }) {
  const startedAt = Date.now();
  state.providerRequestCount += 1;
  state.activeProviderRequest = {
    id: `model_request_${state.providerRequestCount}`,
    index: state.providerRequestCount,
    startedAt,
  };
  out.turnEvent(
    'model.request.started',
    { request_id: state.activeProviderRequest.id, request_index: state.activeProviderRequest.index },
    startedAt
  );
}

function completeProviderRequest({ state, out }, status, delta = null, at = Date.now()) {
  if (!state.activeProviderRequest) return;
  const request = state.activeProviderRequest;
  state.activeProviderRequest = null;
  const durationMs = Math.max(0, at - request.startedAt);
  state.providerDurationMs += durationMs;
  out.turnEvent(
    `model.request.${status}`,
    {
      request_id: request.id,
      request_index: request.index,
      duration_ms: durationMs,
      ...(delta ? { usage: usageDeltaSummary(delta) } : {}),
    },
    at
  );
}

function flushReasoning({ state, out }, at = Date.now()) {
  const text = state.reasoningText;
  state.reasoningText = '';
  if (!text.trim()) return;
  out.itemCompleted({ id: out.nextItemId('reasoning'), type: 'reasoning', text, status: 'completed' }, at);
}

function emitAssistant(ctx, text, at = Date.now()) {
  const value = String(text ?? '');
  if (!value.trim()) return;
  flushReasoning(ctx, at);
  ctx.state.lastAssistantText = value;
  ctx.out.itemCompleted(
    { id: ctx.out.nextItemId('message'), type: 'agent_message', text: value, status: 'completed' },
    at
  );
}

function startTool({ state, out }, call, at = Date.now()) {
  const callId = clean(call?.id) || out.nextItemId('tool');
  if (state.pendingTools.has(callId) || state.completedTools.has(callId)) return;
  const entry = {
    id: callId,
    name: toolCallName(call),
    arguments: toolCallArguments(call),
    startedAt: at,
    startedAtIso: nowIso(at),
  };
  state.pendingTools.set(callId, entry);
  state.toolCallCount += 1;
  out.turnEvent(
    'item.started',
    { item: toolCallItem(entry, { status: 'in_progress', started_at: entry.startedAtIso }) },
    at
  );
}

function completeTool(ctx, message, at = Date.now()) {
  const { state, out } = ctx;
  const callId = clean(message?.toolCallId);
  if (!callId || state.completedTools.has(callId)) return;
  let entry = state.pendingTools.get(callId);
  if (!entry) {
    startTool(ctx, { id: callId, name: message?.toolName || 'tool', arguments: {} }, at);
    entry = state.pendingTools.get(callId);
  }
  if (!entry) return;
  // An early notify only records the engine's completion mark; the item closes
  // when the final result message lands.
  if (message?.__earlyNotify === true) {
    entry.earlyCompletedAt = at;
    entry.earlyTiming = message?.toolTiming || null;
    return;
  }
  state.pendingTools.delete(callId);
  state.completedTools.add(callId);
  const timing = toolTimingFor(entry, message, at);
  out.itemCompleted(
    toolCallItem(entry, {
      output: jsonValue(message?.content),
      status: toolCallStatus(message),
      started_at: entry.startedAtIso,
      completed_at: nowIso(at),
      duration_ms: timing.total_ms,
      timing,
    }),
    at
  );
}

function closePendingTools({ state, out }, status, output, at = Date.now()) {
  for (const entry of state.pendingTools.values()) {
    state.completedTools.add(entry.id);
    out.itemCompleted(
      toolCallItem(entry, {
        output,
        status,
        started_at: entry.startedAtIso,
        completed_at: nowIso(at),
        duration_ms: Math.max(0, at - entry.startedAt),
      }),
      at
    );
  }
  state.pendingTools.clear();
}

function toolBatchStarted({ state, out }) {
  const startedAt = Date.now();
  state.activeToolBatch = { id: `tool_batch_${state.providerRequestCount || 1}`, startedAt };
  out.turnEvent('tool.batch.started', { batch_id: state.activeToolBatch.id }, startedAt);
}

function toolBatchCompleted({ state, out }, detail = {}) {
  const completedAt = Date.now();
  const batch = state.activeToolBatch || {
    id: `tool_batch_${state.providerRequestCount || 1}`,
    startedAt: completedAt,
  };
  state.activeToolBatch = null;
  out.turnEvent(
    'tool.batch.completed',
    {
      batch_id: batch.id,
      iteration: nonNegativeNumber(detail.iteration),
      calls: nonNegativeNumber(detail.calls),
      duration_ms: nonNegativeNumber(detail.elapsedMs ?? completedAt - batch.startedAt),
    },
    completedAt
  );
}

/** Flush and close every open item, then settle the turn's totals. */
function settleTurn(ctx, status, closeOutput, completedAt) {
  const { state, stats } = ctx;
  flushReasoning(ctx, completedAt);
  completeProviderRequest(ctx, status, null, completedAt);
  closePendingTools(ctx, status === 'completed' ? 'incomplete' : 'failed', closeOutput, completedAt);
  return {
    durationMs: Math.max(0, completedAt - state.turnStartedAt),
    usage: usageSummary(stats, state.toolCallCount),
  };
}

function resultEvent({ state, out }, { subtype, isError, durationMs, usage, fields }, at) {
  out.emit(
    {
      type: 'result',
      subtype,
      thread_id: state.threadId,
      turn_id: state.turnId,
      session_id: state.threadId,
      model: state.model,
      is_error: isError,
      duration_ms: durationMs,
      duration_api_ms: state.providerDurationMs,
      num_turns: 1,
      provider_requests: state.providerRequestCount,
      tool_calls: state.toolCallCount,
      ...fields,
      usage,
    },
    at
  );
}

function succeed(ctx, text, result = null) {
  const { state, out } = ctx;
  startThread(ctx);
  const completedAt = Date.now();
  const { durationMs, usage } = settleTurn(ctx, 'completed', null, completedAt);
  const finalText = String(text ?? '');
  if (finalText.trim() && finalText !== state.lastAssistantText) {
    emitAssistant(ctx, finalText, completedAt);
  }
  const terminationReason = clean(result?.terminationReason) || null;
  out.turnEvent(
    'turn.completed',
    {
      duration_ms: durationMs,
      duration_api_ms: state.providerDurationMs,
      provider_requests: state.providerRequestCount,
      tool_calls: state.toolCallCount,
      usage,
    },
    completedAt
  );
  resultEvent(
    ctx,
    {
      subtype: 'success',
      isError: terminationReason === 'refusal',
      durationMs,
      usage,
      fields: {
        result: finalText,
        stop_reason: result?.stopReason ?? result?.stop_reason ?? null,
        termination_reason: terminationReason,
      },
    },
    completedAt
  );
}

function fail(ctx, error) {
  const { state, out } = ctx;
  startThread(ctx);
  const completedAt = Date.now();
  const message = error?.message || String(error || 'execution failed');
  const { durationMs, usage } = settleTurn(ctx, 'failed', message, completedAt);
  out.turnEvent(
    'turn.failed',
    { duration_ms: durationMs, duration_api_ms: state.providerDurationMs, error: { message }, usage },
    completedAt
  );
  resultEvent(
    ctx,
    {
      subtype: 'error_during_execution',
      isError: true,
      durationMs,
      usage,
      fields: { stop_reason: null, errors: [message] },
    },
    completedAt
  );
}

export function createJsonLifecycle({ write, stats, provider, model, effort, fast, cwd, webSearch = false }) {
  const state = createStreamState({ provider, model, effort, fast, cwd, webSearch });
  const ctx = { state, stats, out: createEventWriter(write, state) };
  return {
    get threadId() {
      return state.threadId;
    },
    get toolCallCount() {
      return state.toolCallCount;
    },
    start: (runtime = null) => startThread(ctx, runtime),
    onProviderSendStarted() {
      startThread(ctx);
      if (state.activeProviderRequest) completeProviderRequest(ctx, 'failed');
      startProviderRequest(ctx);
    },
    onUsageDelta(delta) {
      completeProviderRequest(ctx, 'completed', delta);
    },
    onReasoningDelta(chunk) {
      state.reasoningText += String(chunk ?? '');
    },
    onAssistantText(text) {
      emitAssistant(ctx, text);
    },
    onAssistantToolCallObserved(call) {
      startThread(ctx);
      flushReasoning(ctx);
      startTool(ctx, call);
    },
    onToolCall(_iteration, calls) {
      startThread(ctx);
      flushReasoning(ctx);
      for (const call of calls || []) startTool(ctx, call);
    },
    onToolResult(message) {
      completeTool(ctx, message);
    },
    onToolBatchStarted: () => toolBatchStarted(ctx),
    onToolBatchCompleted: (detail = {}) => toolBatchCompleted(ctx, detail),
    onStageChange(stage, detail = null) {
      ctx.out.turnEvent('turn.status', {
        stage: clean(stage) || 'unknown',
        ...(detail == null ? {} : { detail: jsonValue(detail) }),
      });
    },
    onNotification(event = {}) {
      ctx.out.turnEvent('notification', {
        content: String(event?.content ?? ''),
        meta: jsonValue(event?.meta ?? {}),
      });
      return false;
    },
    succeed: (text, result = null) => succeed(ctx, text, result),
    fail: (error) => fail(ctx, error),
  };
}
