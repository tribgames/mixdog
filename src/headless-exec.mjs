import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { stderr, stdout } from 'node:process';

import {
  createPristineExecutionBoundary,
  validateExplicitPristineRoute,
} from './runtime/shared/pristine-execution.mjs';
import { hasActiveBackgroundTasks } from './runtime/shared/background-tasks.mjs';
import { installProcessSignalCleanup } from './runtime/shared/process-shutdown.mjs';
import { applyUsageDelta, createSessionStats } from './ui/session-stats.mjs';

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonNegativeNumber(value) {
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
  return clean(
    call?.name
    ?? call?.toolName
    ?? call?.function?.name
    ?? call?.tool?.name,
  ) || 'tool';
}

function toolCallArguments(call) {
  const raw = call?.arguments
    ?? call?.input
    ?? call?.function?.arguments
    ?? call?.tool?.arguments
    ?? call?.args
    ?? {};
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

function createJsonLifecycle({
  write,
  stats,
  provider,
  model,
  effort,
  fast,
  cwd,
  webSearch = false,
  memory = false,
}) {
  let threadId = `exec_${randomUUID().replace(/-/g, '')}`;
  const turnId = 'turn_1';
  let resolvedProvider = clean(provider);
  let resolvedModel = clean(model);
  let resolvedEffort = clean(effort) || null;
  let resolvedFast = fast === true;
  let resolvedCwd = clean(cwd);
  let started = false;
  let turnStartedAt = 0;
  let itemSequence = 0;
  let toolCallCount = 0;
  let providerRequestCount = 0;
  let providerDurationMs = 0;
  let activeProviderRequest = null;
  let activeToolBatch = null;
  let reasoningText = '';
  let lastAssistantText = '';
  const pendingTools = new Map();
  const completedTools = new Set();

  const nowIso = (value = Date.now()) => new Date(value).toISOString();
  const emit = (event, at = Date.now()) => {
    write(`${JSON.stringify({
      schema_version: 1,
      timestamp: nowIso(at),
      ...event,
    })}\n`);
  };
  const nextItemId = (prefix = 'item') => `${prefix}_${++itemSequence}`;

  function start(runtime = null) {
    if (started) return;
    threadId = clean(runtime?.id) || threadId;
    resolvedProvider = clean(runtime?.provider) || resolvedProvider;
    resolvedModel = clean(runtime?.model) || resolvedModel;
    resolvedEffort = clean(runtime?.effort) || resolvedEffort;
    resolvedFast = runtime?.fast === true || resolvedFast;
    resolvedCwd = clean(runtime?.cwd) || resolvedCwd;
    turnStartedAt = Date.now();
    started = true;
    emit({
      type: 'thread.started',
      thread_id: threadId,
      session: {
        provider: resolvedProvider,
        model: resolvedModel,
        effort: resolvedEffort,
        fast: resolvedFast,
        cwd: resolvedCwd,
        tool_mode: 'full',
        approval_mode: 'implicit',
        delegation: false,
        web_search: webSearch === true,
        memory: memory === true,
      },
    }, turnStartedAt);
    emit({
      type: 'turn.started',
      thread_id: threadId,
      turn_id: turnId,
    }, turnStartedAt);
  }

  function completeProviderRequest(status, delta = null, at = Date.now()) {
    if (!activeProviderRequest) return;
    const request = activeProviderRequest;
    activeProviderRequest = null;
    const durationMs = Math.max(0, at - request.startedAt);
    providerDurationMs += durationMs;
    emit({
      type: `model.request.${status}`,
      thread_id: threadId,
      turn_id: turnId,
      request_id: request.id,
      request_index: request.index,
      duration_ms: durationMs,
      ...(delta ? { usage: usageDeltaSummary(delta) } : {}),
    }, at);
  }

  function flushReasoning(at = Date.now()) {
    const text = reasoningText;
    reasoningText = '';
    if (!text.trim()) return;
    emit({
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: nextItemId('reasoning'),
        type: 'reasoning',
        text,
        status: 'completed',
      },
    }, at);
  }

  function emitAssistant(text, at = Date.now()) {
    const value = String(text ?? '');
    if (!value.trim()) return;
    flushReasoning(at);
    lastAssistantText = value;
    emit({
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: nextItemId('message'),
        type: 'agent_message',
        text: value,
        status: 'completed',
      },
    }, at);
  }

  function startTool(call, at = Date.now()) {
    const callId = clean(call?.id) || nextItemId('tool');
    if (pendingTools.has(callId) || completedTools.has(callId)) return;
    const entry = {
      id: callId,
      name: toolCallName(call),
      arguments: toolCallArguments(call),
      startedAt: at,
      startedAtIso: nowIso(at),
    };
    pendingTools.set(callId, entry);
    toolCallCount += 1;
    emit({
      type: 'item.started',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: entry.id,
        type: 'tool_call',
        name: entry.name,
        arguments: entry.arguments,
        status: 'in_progress',
        started_at: entry.startedAtIso,
      },
    }, at);
  }

  function completeTool(message, at = Date.now()) {
    const callId = clean(message?.toolCallId);
    if (!callId || completedTools.has(callId)) return;
    let entry = pendingTools.get(callId);
    if (!entry) {
      startTool({ id: callId, name: message?.toolName || 'tool', arguments: {} }, at);
      entry = pendingTools.get(callId);
    }
    if (!entry) return;
    if (message?.__earlyNotify === true) {
      entry.earlyCompletedAt = at;
      entry.earlyTiming = message?.toolTiming || null;
      return;
    }
    pendingTools.delete(callId);
    completedTools.add(callId);
    const failed = message?.isError === true || message?.toolKind === 'error';
    const skipped = message?.toolKind === 'skipped';
    const rawTiming = message?.toolTiming || entry.earlyTiming || {};
    const dispatchStartedAt = nonNegativeNumber(rawTiming.dispatchStartedAt || entry.startedAt);
    const executionStartedAt = nonNegativeNumber(
      rawTiming.executionStartedAt || dispatchStartedAt,
    );
    const executionCompletedAt = nonNegativeNumber(
      rawTiming.executionCompletedAt || entry.earlyCompletedAt || at,
    );
    const postprocessStartedAt = nonNegativeNumber(
      rawTiming.postprocessStartedAt || executionCompletedAt,
    );
    const resultCompletedAt = nonNegativeNumber(rawTiming.resultCompletedAt || at);
    const timing = {
      queue_ms: Math.max(0, dispatchStartedAt - entry.startedAt),
      dispatch_ms: Math.max(0, executionStartedAt - dispatchStartedAt),
      execution_ms: Math.max(0, executionCompletedAt - executionStartedAt),
      batch_wait_ms: Math.max(0, postprocessStartedAt - executionCompletedAt),
      postprocess_ms: Math.max(0, resultCompletedAt - postprocessStartedAt),
      total_ms: Math.max(0, resultCompletedAt - entry.startedAt),
    };
    emit({
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: entry.id,
        type: 'tool_call',
        name: entry.name,
        arguments: entry.arguments,
        output: jsonValue(message?.content),
        status: failed ? 'failed' : (skipped ? 'skipped' : 'completed'),
        started_at: entry.startedAtIso,
        completed_at: nowIso(at),
        duration_ms: timing.total_ms,
        timing,
      },
    }, at);
  }

  function closePendingTools(status, output, at = Date.now()) {
    for (const entry of pendingTools.values()) {
      completedTools.add(entry.id);
      emit({
        type: 'item.completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          id: entry.id,
          type: 'tool_call',
          name: entry.name,
          arguments: entry.arguments,
          output,
          status,
          started_at: entry.startedAtIso,
          completed_at: nowIso(at),
          duration_ms: Math.max(0, at - entry.startedAt),
        },
      }, at);
    }
    pendingTools.clear();
  }

  return {
    get threadId() {
      return threadId;
    },
    get toolCallCount() {
      return toolCallCount;
    },
    start,
    onProviderSendStarted() {
      start();
      if (activeProviderRequest) completeProviderRequest('failed');
      const startedAt = Date.now();
      providerRequestCount += 1;
      activeProviderRequest = {
        id: `model_request_${providerRequestCount}`,
        index: providerRequestCount,
        startedAt,
      };
      emit({
        type: 'model.request.started',
        thread_id: threadId,
        turn_id: turnId,
        request_id: activeProviderRequest.id,
        request_index: activeProviderRequest.index,
      }, startedAt);
    },
    onUsageDelta(delta) {
      completeProviderRequest('completed', delta);
    },
    onReasoningDelta(chunk) {
      reasoningText += String(chunk ?? '');
    },
    onAssistantText(text) {
      emitAssistant(text);
    },
    onAssistantToolCallObserved(call) {
      start();
      flushReasoning();
      startTool(call);
    },
    onToolCall(_iteration, calls) {
      start();
      flushReasoning();
      for (const call of calls || []) startTool(call);
    },
    onToolResult(message) {
      completeTool(message);
    },
    onToolBatchStarted() {
      const startedAt = Date.now();
      activeToolBatch = {
        id: `tool_batch_${providerRequestCount || 1}`,
        startedAt,
      };
      emit({
        type: 'tool.batch.started',
        thread_id: threadId,
        turn_id: turnId,
        batch_id: activeToolBatch.id,
      }, startedAt);
    },
    onToolBatchCompleted(detail = {}) {
      const completedAt = Date.now();
      const batch = activeToolBatch || {
        id: `tool_batch_${providerRequestCount || 1}`,
        startedAt: completedAt,
      };
      activeToolBatch = null;
      emit({
        type: 'tool.batch.completed',
        thread_id: threadId,
        turn_id: turnId,
        batch_id: batch.id,
        iteration: nonNegativeNumber(detail.iteration),
        calls: nonNegativeNumber(detail.calls),
        duration_ms: nonNegativeNumber(
          detail.elapsedMs ?? (completedAt - batch.startedAt),
        ),
      }, completedAt);
    },
    onStageChange(stage, detail = null) {
      emit({
        type: 'turn.status',
        thread_id: threadId,
        turn_id: turnId,
        stage: clean(stage) || 'unknown',
        ...(detail == null ? {} : { detail: jsonValue(detail) }),
      });
    },
    onNotification(event = {}) {
      emit({
        type: 'notification',
        thread_id: threadId,
        turn_id: turnId,
        content: String(event?.content ?? ''),
        meta: jsonValue(event?.meta ?? {}),
      });
      return false;
    },
    succeed(text, result = null) {
      start();
      const completedAt = Date.now();
      flushReasoning(completedAt);
      completeProviderRequest('completed', null, completedAt);
      closePendingTools('incomplete', null, completedAt);
      const finalText = String(text ?? '');
      if (finalText.trim() && finalText !== lastAssistantText) {
        emitAssistant(finalText, completedAt);
      }
      const durationMs = Math.max(0, completedAt - turnStartedAt);
      const usage = usageSummary(stats, toolCallCount);
      emit({
        type: 'turn.completed',
        thread_id: threadId,
        turn_id: turnId,
        duration_ms: durationMs,
        duration_api_ms: providerDurationMs,
        provider_requests: providerRequestCount,
        tool_calls: toolCallCount,
        usage,
      }, completedAt);
      emit({
        type: 'result',
        subtype: 'success',
        thread_id: threadId,
        turn_id: turnId,
        session_id: threadId,
        model: resolvedModel,
        is_error: false,
        duration_ms: durationMs,
        duration_api_ms: providerDurationMs,
        num_turns: 1,
        provider_requests: providerRequestCount,
        tool_calls: toolCallCount,
        result: finalText,
        stop_reason: result?.stopReason ?? result?.stop_reason ?? null,
        usage,
      }, completedAt);
    },
    fail(error) {
      start();
      const completedAt = Date.now();
      const message = error?.message || String(error || 'execution failed');
      flushReasoning(completedAt);
      completeProviderRequest('failed', null, completedAt);
      closePendingTools('failed', message, completedAt);
      const durationMs = Math.max(0, completedAt - turnStartedAt);
      const usage = usageSummary(stats, toolCallCount);
      emit({
        type: 'turn.failed',
        thread_id: threadId,
        turn_id: turnId,
        duration_ms: durationMs,
        duration_api_ms: providerDurationMs,
        error: { message },
        usage,
      }, completedAt);
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        thread_id: threadId,
        turn_id: turnId,
        session_id: threadId,
        model: resolvedModel,
        is_error: true,
        duration_ms: durationMs,
        duration_api_ms: providerDurationMs,
        num_turns: 1,
        provider_requests: providerRequestCount,
        tool_calls: toolCallCount,
        stop_reason: null,
        errors: [message],
        usage,
      }, completedAt);
    },
  };
}

export async function waitForTrackedTasks({
  sessionId,
  clientHostPid = process.pid,
  hasActiveTasks = hasActiveBackgroundTasks,
  pollMs = 100,
} = {}) {
  const scope = {
    ...(clean(sessionId) ? { callerSessionId: clean(sessionId) } : {}),
    clientHostPid,
  };
  while (hasActiveTasks(scope)) {
    await sleep(Math.max(10, Number(pollMs) || 100));
  }
}

function writeUsageDocument(path, stats, runtime, toolCallCount = 0) {
  const target = clean(path);
  if (!target) return;
  const session = {
    sessionId: clean(runtime?.id),
    agentRole: 'primary',
    models: [clean(runtime?.model)].filter(Boolean),
    inputTokens: stats.inputTokens,
    cacheTokens: stats.cachedTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    outputTokens: stats.outputTokens,
    toolCallCountApprox: nonNegativeNumber(toolCallCount),
  };
  const document = {
    schemaVersion: 1,
    sessions: [session],
    totals: {
      inputTokens: stats.inputTokens,
      cacheTokens: stats.cachedTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      outputTokens: stats.outputTokens,
      toolCallCountApprox: nonNegativeNumber(toolCallCount),
    },
  };
  const temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export async function runHeadlessExec({
  message,
  provider,
  model,
  effort,
  fast,
  webSearch = false,
  memory = false,
  json = false,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
  usageLogPath = process.env.MIXDOG_USAGE_LOG,
  boundaryFactory = createPristineExecutionBoundary,
  runtimeFactory = null,
  hasActiveTasks = hasActiveBackgroundTasks,
  installSignalCleanupFn = installProcessSignalCleanup,
  idlePollMs = 100,
} = {}) {
  const prompt = clean(message);
  if (!prompt) {
    writeErr('mixdog: message is required\n');
    return 1;
  }
  const routeError = validateExplicitPristineRoute({ provider, model, effort, fast });
  if (routeError) {
    writeErr(`mixdog: ${routeError}\n`);
    return 1;
  }

  const stats = createSessionStats();
  const lifecycle = json ? createJsonLifecycle({
    write,
    stats,
    provider,
    model,
    effort,
    fast,
    cwd,
    webSearch,
    memory,
  }) : null;
  let boundary = null;
  let runtime = null;
  let signalCleanup = null;
  let unsubscribeNotification = null;
  let cleanupPromise = null;
  let result = null;
  let resultText = '';
  let executionError = null;
  let code = 1;
  const cleanup = (reason = 'exec-exit') => {
    cleanupPromise ??= (async () => {
      try {
        if (runtime) await runtime.close(reason);
      } finally {
        boundary?.cleanup();
      }
    })();
    return cleanupPromise;
  };

  try {
    boundary = boundaryFactory({ provider, model, effort, fast });
    signalCleanup = installSignalCleanupFn({
      name: 'mixdog-exec',
      timeoutMs: 6500,
      cleanup,
    });
    const createRuntime = runtimeFactory || (
      await import('./mixdog-session-runtime.mjs')
    ).createMixdogSessionRuntime;
    // Headless defaults: web research and memory tools stay OFF unless the
    // caller opts in via --web-search / --memory. Delegation is already
    // disallowed below, completing the solo surface. The per-process
    // MIXDOG_FEATURE_* overrides are the runtime's canonical switches.
    process.env.MIXDOG_FEATURE_WEB_SEARCH = webSearch === true ? '1' : '0';
    process.env.MIXDOG_FEATURE_MEMORY = memory === true ? '1' : '0';
    runtime = await createRuntime({
      provider,
      model,
      cwd,
      toolMode: 'full',
      approvalMode: 'implicit',
      disallowDelegation: true,
      initialConfig: boundary.loadConfig(),
    });
    if (lifecycle && !clean(runtime?.id) && typeof runtime?.reserveSessionId === 'function') {
      runtime.reserveSessionId(lifecycle.threadId);
    }
    lifecycle?.start(runtime);
    if (lifecycle && typeof runtime?.onNotification === 'function') {
      unsubscribeNotification = runtime.onNotification(
        (event) => lifecycle.onNotification(event),
      );
    }
    ({ result } = await runtime.ask(prompt, {
      onTextReset: () => true,
      onUsageDelta: (delta) => {
        applyUsageDelta(stats, delta);
        lifecycle?.onUsageDelta(delta);
      },
      ...(lifecycle ? {
        onProviderSendStarted: () => lifecycle.onProviderSendStarted(),
        onReasoningDelta: (chunk) => lifecycle.onReasoningDelta(chunk),
        onAssistantText: (text) => lifecycle.onAssistantText(text),
        onAssistantToolCallObserved: (call) => lifecycle.onAssistantToolCallObserved(call),
        onToolCall: (iteration, calls) => lifecycle.onToolCall(iteration, calls),
        onToolResult: (message) => lifecycle.onToolResult(message),
        onToolPhaseStarted: () => lifecycle.onToolBatchStarted(),
        onToolPhaseCompleted: (detail) => lifecycle.onToolBatchCompleted(detail),
        onStageChange: (stage, detail) => lifecycle.onStageChange(stage, detail),
      } : {}),
    }));
    await waitForTrackedTasks({
      sessionId: runtime.id,
      clientHostPid: runtime.clientHostPid,
      hasActiveTasks,
      pollMs: idlePollMs,
    });
    resultText = String(result?.content ?? result?.text ?? '');
    if (!json && resultText) {
      write(resultText.endsWith('\n') ? resultText : `${resultText}\n`);
    }
    code = 0;
  } catch (error) {
    executionError = error;
    writeErr(`mixdog: ${error?.message || error}\n`);
  } finally {
    try {
      unsubscribeNotification?.();
    } catch {
      // Listener cleanup is best-effort.
    }
    try {
      writeUsageDocument(
        usageLogPath,
        stats,
        runtime,
        lifecycle?.toolCallCount || 0,
      );
    } catch (error) {
      writeErr(`mixdog: usage log write failed: ${error?.message || error}\n`);
    }
    try {
      await cleanup('exec-exit');
    } catch (error) {
      executionError ??= error;
      writeErr(`mixdog: shutdown failed: ${error?.message || error}\n`);
      code = 1;
    } finally {
      signalCleanup?.uninstall();
    }
  }
  if (lifecycle) {
    if (code === 0) lifecycle.succeed(resultText, result);
    else lifecycle.fail(executionError || new Error('execution failed'));
  }
  return code;
}
