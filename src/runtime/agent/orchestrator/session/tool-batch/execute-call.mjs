// Runs one call that passed the pre-dispatch guards: cache lookups,
// eager-result consumption or serial execution, and the same-anchor edit
// retry. Returns the execution record the outcome/finalize phases consume.
import { markSessionToolCall } from '../manager.mjs';
import { classifyResultKind } from '../result-classification.mjs';
import { normalizeToolEnvelope } from '../tool-envelope.mjs';
import { captureReadCacheState, tryReadCached, tryScopedToolCached } from '../read-dedup.mjs';
import { isInvalidToolArgsMarker, formatInvalidToolArgsResult } from '../../providers/openai-compat-stream.mjs';
import { _stripMcpPrefix, _isReadTool, _isScopedCacheableTool } from '../loop/tool-classify.mjs';
import { preDispatchDenyForSession } from '../loop/pre-dispatch-deny.mjs';
import { getToolKind, isEagerDispatchable, isParallelDispatchable } from '../loop/tool-helpers.mjs';
import { scopedCacheGeneration } from '../cache/scoped-cache.mjs';
import { editSeqGroupFor } from './plan.mjs';

function classifyToolReturn(value, toolName = '') {
  const normalized = normalizeToolEnvelope(value);
  if (normalized.explicitFailure) return 'error';
  return classifyResultKind(normalized.result, normalized.explicitSuccess, toolName);
}

export async function executeBatchCall(batch, call, callIndex) {
  const { sessionId, sessionRef } = batch;
  if (sessionId) markSessionToolCall(sessionId, call.name);
  const exec = {
    result: undefined,
    resultKind: 'normal',
    executeOk: false,
    dispatchStartedAt: Date.now(),
    executionStartedAt: undefined,
    toolStartedAt: undefined,
    toolEndedAt: undefined,
    executionIntervals: [],
    toolKind: getToolKind(call.name, sessionRef?.mcpScopeId),
    readCacheHit: null,
    readCacheState: null,
    scopedCacheHit: null,
    scopedGeneration: scopedCacheGeneration(),
    localSearchTelemetry: null,
    resultTelemetry: {},
    eagerExecution: null,
    serialExecutionStartedAt: null,
  };
  // Invalid-args guard (native convergence): the provider parser tags a
  // tool call whose arguments JSON could not be parsed with a marker
  // instead of throwing or swallowing to {}. Such a call must NOT execute
  // and gets no cache lookup — the model gets an is_error tool_result and
  // re-issues the call with valid JSON in the same turn.
  const invalidArgs = isInvalidToolArgsMarker(call.arguments);
  if (!invalidArgs) lookupCaches(batch, call, exec);
  try {
    if (invalidArgs) {
      markInstant(exec);
      exec.result = formatInvalidToolArgsResult(call);
      exec.resultKind = 'error';
      exec.executeOk = false;
    } else if (exec.readCacheHit !== null) {
      serveCached(exec, exec.readCacheHit.content, 'cache-hit');
    } else if (exec.scopedCacheHit !== null) {
      serveCached(exec, exec.scopedCacheHit.content, 'scoped-cache-hit');
    } else {
      await executeLive(batch, call, callIndex, exec);
    }
  } catch (err) {
    if (exec.toolStartedAt === undefined) exec.toolStartedAt = Date.now();
    if (exec.executionStartedAt === undefined) exec.executionStartedAt = exec.toolStartedAt;
    exec.toolEndedAt = Date.now();
    exec.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    exec.resultKind = 'error';
  }
  recordExecutionInterval(exec);
  await retryAmbiguousEdit(batch, call, exec);
  return exec;
}

// Cross-turn read dedup: an unchanged stat tuple (mtime/ctime/size/ino/dev)
// since a prior read in THIS session returns the cached body instead of
// executing. Scoped-tool cache (grep/glob/list + graph lookups): keyed by
// (toolName, canonical args) without per-file stat, since these tools scan
// many files; write-class tools evict entries whose registered dependency
// root contains the touched path.
function lookupCaches(batch, call, exec) {
  const { sessionId, cwd } = batch;
  if (sessionId && _isReadTool(call.name)) {
    exec.readCacheHit = tryReadCached({ sessionId, args: call.arguments, cwd });
  } else if (sessionId && _isScopedCacheableTool(call.name)) {
    exec.scopedCacheHit = tryScopedToolCached({
      sessionId,
      toolName: _stripMcpPrefix(call.name),
      args: call.arguments,
      cwd,
    });
  }
}

function markInstant(exec) {
  exec.toolStartedAt = Date.now();
  exec.executionStartedAt = exec.toolStartedAt;
  exec.toolEndedAt = exec.toolStartedAt;
}

// The cached body byte-for-byte, not a human-readable cache marker: the
// marker made public agents treat a successful cached read as a meta
// instruction and repeat the same read loop.
function serveCached(exec, content, resultKind) {
  markInstant(exec);
  exec.result = content;
  exec.resultKind = resultKind;
  exec.executeOk = true;
}

async function executeLive(batch, call, callIndex, exec) {
  const { calls, plan, pending, epoch, tools, startEagerRun } = batch;
  // Fallback for providers that don't stream tool calls early: dispatch
  // the whole remaining batch. The eager dispatcher keeps independent
  // calls parallel while making shell wait for earlier apply_patch calls.
  if (isParallelDispatchable(call.name)) startEagerRun(calls, callIndex, plan.duplicateCallIds);
  let eager = pending.get(call.id);
  // Post-mutation invalidation applies ONLY to read-only results: a read
  // that raced an apply_patch re-executes for fresh content. Non-read-only
  // parallel calls (shell/MCP/...) already ran — their side effects are
  // real, so their results are consumed as-is and NEVER re-executed.
  if (eager !== undefined && eager.mutationEpoch < epoch.mutation && isEagerDispatchable(call.name, tools)) {
    pending.delete(call.id);
    eager = undefined;
  }
  if (eager !== undefined) await consumeEagerResult(call, eager, exec);
  else await executeSerially(batch, call, exec);
}

async function consumeEagerResult(call, eager, exec) {
  exec.eagerExecution = eager;
  exec.toolStartedAt = eager.startedAt;
  exec.dispatchStartedAt = eager.dispatchStartedAt ?? eager.startedAt;
  exec.executionStartedAt = eager.executionStartedAt ?? eager.endedAt;
  exec.localSearchTelemetry = eager.localSearchTelemetry || null;
  exec.resultTelemetry = eager.resultTelemetry || {};
  const settled = await eager.promise;
  if (!settled.ok) throw settled.error;
  exec.readCacheState = eager.readCacheState ?? null;
  exec.result = settled.value;
  exec.toolEndedAt = eager.endedAt ?? Date.now();
  if (settled.skipped) {
    exec.resultKind = 'skipped';
    exec.executeOk = false;
  } else {
    classifyExecuted(call, exec);
  }
}

async function executeSerially(batch, call, exec) {
  const { sessionId, sessionRef, cwd, opts, executeToolFn } = batch;
  exec.toolStartedAt = Date.now();
  // Runtime pre-dispatch deny: schema profiles may hide tools for routing
  // efficiency, but this remains the control-plane boundary for any
  // tool_use that still reaches the loop. Shared with the eager path
  // (startEagerTool) so both paths reject consistently.
  const denyMsg = preDispatchDenyForSession(sessionRef, call, exec.toolKind);
  if (denyMsg !== null) {
    exec.executionStartedAt = exec.toolStartedAt;
    exec.result = denyMsg;
    exec.toolEndedAt = Date.now();
    exec.resultKind = 'error';
    return;
  }
  await opts.beforeToolExecution?.();
  if (sessionId && _isReadTool(call.name)) {
    exec.readCacheState = captureReadCacheState({ args: call.arguments, cwd });
  }
  exec.executionStartedAt = Date.now();
  exec.serialExecutionStartedAt = exec.executionStartedAt;
  exec.localSearchTelemetry = {};
  exec.result = await executeToolFn(
    call.name,
    call.arguments,
    cwd,
    sessionId,
    sessionRef,
    invocationOptions(batch, call, exec)
  );
  exec.toolEndedAt = Date.now();
  classifyExecuted(call, exec);
}

// Downstream layers operate on resultKind, which stays 'normal' for a
// non-error return. Prefix classification belongs to result-classification.mjs.
function classifyExecuted(call, exec) {
  if (classifyToolReturn(exec.result, call.name) === 'error') {
    exec.resultKind = 'error';
    exec.executeOk = false;
  } else {
    exec.executeOk = true;
  }
}

function invocationOptions(batch, call, exec) {
  return {
    toolCallId: call.id,
    signal: batch.signal,
    notifyFn: batch.opts.notifyFn,
    toolApprovalHook: batch.opts.onToolApproval,
    iteration: batch.iterations,
    localSearchTelemetry: exec.localSearchTelemetry || {},
    resultTelemetry: exec.resultTelemetry,
  };
}

// Eager timestamps are mutable until settlement: read them now, not before
// awaiting a call queued behind a mutation barrier.
function recordExecutionInterval(exec) {
  const eager = exec.eagerExecution;
  if (eager?.executionStartedAt != null && eager?.endedAt != null) {
    exec.executionIntervals.push({ started_at_ms: eager.executionStartedAt, completed_at_ms: eager.endedAt });
  } else if (exec.serialExecutionStartedAt !== null) {
    exec.executionIntervals.push({ started_at_ms: exec.serialExecutionStartedAt, completed_at_ms: exec.toolEndedAt });
  }
}

// Same-anchor batch occupation retry (plan.editSeqGroups): an
// ambiguity-rejected member of a known batch group re-executes once in
// call order. With 2+ occurrences remaining it passes the remaining count
// so the adapter deterministically consumes the first one; with exactly 1
// remaining a plain re-run resolves through the normal unique path. A
// rejected edit had no side effects, so re-execution is safe.
async function retryAmbiguousEdit(batch, call, exec) {
  const group = editSeqGroupFor(batch.plan, call);
  if (!group) return;
  const remaining = group.total - group.applied;
  if (remaining >= 1 && isAmbiguousEditFailure(exec)) await rerunAmbiguousEdit(batch, call, exec, remaining);
  if (exec.executeOk && exec.resultKind !== 'skipped') group.applied += 1;
}

function isAmbiguousEditFailure(exec) {
  return (
    exec.resultKind === 'error' && typeof exec.result === 'string' && /old_string found \d+ times/.test(exec.result)
  );
}

async function rerunAmbiguousEdit(batch, call, exec, remaining) {
  const retryStartedAt = Date.now();
  try {
    const retry = await batch.executeToolFn(call.name, call.arguments, batch.cwd, batch.sessionId, batch.sessionRef, {
      ...invocationOptions(batch, call, exec),
      ...(remaining >= 2 ? { editOccurrence: { expected: remaining } } : {}),
    });
    if (classifyToolReturn(retry, call.name) === 'error') return;
    exec.result = retry;
    exec.resultKind = 'normal';
    exec.executeOk = true;
    exec.toolEndedAt = Date.now();
    // Mirror the eager mutation epoch: later read-only eager results
    // computed against pre-edit content must re-execute.
    batch.epoch.mutation += 1;
  } catch {
    /* keep the original ambiguity error */
  } finally {
    exec.executionIntervals.push({ started_at_ms: retryStartedAt, completed_at_ms: Date.now() });
  }
}
