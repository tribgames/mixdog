// Post-execution pipeline for the whole batch: native tool-search parse,
// lossless offload, then per call trace → cache write → staged tool_result
// → cross-turn record. Cache and transcript therefore receive the same body.
import { takeApplyPatchUiDiff } from '../../tools/patch.mjs';
import { traceAgentShellOutput, traceAgentTool, traceAgentToolFailure, traceAgentToolOutput } from '../../agent-trace.mjs';
import { isOffloadedToolResultText, maybeOffloadToolResultBatch } from '../tool-result-offload.mjs';
import { setReadCached, setScopedToolCached } from '../read-dedup.mjs';
import { _stripMcpPrefix, _isReadTool, _isScopedCacheableTool, _isShellTool } from '../loop/tool-classify.mjs';
import { crossTurnSignature, isEditProgressTool } from '../loop/completion-guards.mjs';
import { isEagerDispatchable, isToolCallDedupEligible, parseNativeToolSearchPayload } from '../loop/tool-helpers.mjs';
import { restoreToolCallBodyForId } from '../loop/stored-tool-args.mjs';
import { stageToolResult } from './state.mjs';

// Tools that publish the per-call mutation UI diff side channel (see
// takeApplyPatchUiDiff): apply_patch plus the edit dialect and its foreign
// str-replace aliases adapted by external-tool-adapters.
const MUTATION_UI_DIFF_TOOLS = new Set([
  'apply_patch',
  'edit',
  'strreplace',
  'str_replace',
  'str_replace_editor',
  'search_replace',
]);

export async function finalizeBatchResults(batch) {
  for (const completed of batch.completed) parseNativeToolSearch(completed);
  const offloadStates = await offloadResults(batch);
  for (let index = 0; index < batch.completed.length; index += 1) {
    postProcessCompleted(batch, batch.completed[index], offloadStates[index]);
    batch.throwIfAborted();
  }
}

function parseNativeToolSearch(completed) {
  try {
    completed.nativeToolSearch = parseNativeToolSearchPayload(completed.call.name, completed.result);
    if (completed.nativeToolSearch?.summary) completed.result = completed.nativeToolSearch.summary;
  } catch (error) {
    completed.postError = error;
  }
}

async function offloadResults(batch) {
  try {
    return await maybeOffloadToolResultBatch(
      batch.sessionId,
      batch.completed.map((completed) => ({
        toolCallId: completed.call.id,
        toolName: _stripMcpPrefix(completed.call.name),
        result: completed.postError ? null : completed.result,
      }))
    );
  } catch (error) {
    return batch.completed.map(() => ({ result: null, error }));
  }
}

function postProcessCompleted(batch, completed, offloadState) {
  const postprocessStartedAt = Date.now();
  try {
    if (completed.postError) throw completed.postError;
    if (offloadState?.error) throw offloadState.error;
    const result = offloadState?.result;
    traceCompleted(batch, completed, result, postprocessStartedAt);
    writeCaches(batch, completed, result);
    stageToolResult(batch, completedToolResult(completed, result, postprocessStartedAt));
    if (completed.executeOk) recordCrossTurn(batch, completed);
  } catch (postErr) {
    stagePostProcessingFailure(batch, completed, postErr, postprocessStartedAt);
  }
}

function toolTiming(completed, postprocessStartedAt) {
  return {
    dispatchStartedAt: completed.dispatchStartedAt,
    executionStartedAt: completed.executionStartedAt ?? completed.toolStartedAt,
    executionCompletedAt: completed.toolEndedAt,
    postprocessStartedAt,
    resultCompletedAt: Date.now(),
  };
}

function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function traceCompleted(batch, completed, result, postprocessStartedAt) {
  const { call } = completed;
  const { sessionId } = batch;
  const preOffloadBytes = utf8Bytes(completed.result);
  const offloaded = isOffloadedToolResultText(result);
  const postOffloadBytes = utf8Bytes(result);
  if (_isShellTool(call.name)) {
    traceAgentShellOutput({
      sessionId,
      toolName: call.name,
      toolCallId: call.id,
      telemetry: completed.resultTelemetry,
      preOffloadBytes,
      postOffloadBytes,
      modelVisibleBytes: utf8Bytes(result),
      offloaded,
      resultKind: completed.resultKind,
    });
  } else if (offloaded) {
    traceAgentToolOutput({
      sessionId,
      toolName: call.name,
      toolCallId: call.id,
      preOffloadBytes,
      postOffloadBytes,
      modelVisibleBytes: postOffloadBytes,
      offloaded: true,
      resultKind: completed.resultKind,
    });
  }
  traceAgentTool({
    sessionId,
    iteration: batch.iterations,
    toolBatchId: batch.toolBatchId,
    toolCallId: call.id,
    executionIntervals: completed.executionIntervals,
    toolName: call.name,
    toolKind: completed.toolKind,
    toolMs: completed.toolEndedAt - completed.toolStartedAt,
    toolArgs: call.arguments,
    agent: batch.sessionRef?.agent || null,
    model: batch.turnModel,
    resultKind: completed.resultKind,
    resultText: result,
    localSearchTelemetry: completed.localSearchTelemetry,
    resultTelemetry: completed.resultTelemetry,
    toolTiming: toolTiming(completed, postprocessStartedAt),
    cwd: batch.cwd,
  });
}

// Deferred cache writes that predate a later mutation are skipped;
// immediate writes used to be invalidated by that mutation. Cache-hit refs
// are never re-stored (resultKind must be 'normal'), and the cache holds
// the same post-offload body as conversation history.
function writeCaches(batch, completed, result) {
  const { sessionId, sessionRef, cwd, epoch } = batch;
  const { call } = completed;
  const outcomeMap = sessionRef?._scopedCacheOutcomeByCallId instanceof Map ? sessionRef._scopedCacheOutcomeByCallId : null;
  const scopedCacheable = completed.scopedCacheHit === null && _isScopedCacheableTool(call.name);
  if (sessionId && completed.executeOk && completed.resultKind === 'normal' && completed.mutationEpoch === epoch.mutation) {
    if (scopedCacheable) {
      const outcome = outcomeMap?.get(call.id);
      setScopedToolCached({
        sessionId,
        toolName: _stripMcpPrefix(call.name),
        args: call.arguments,
        cwd,
        content: result,
        toolUseId: call.id,
        complete: outcome ? outcome.complete : true,
        generation: completed.scopedGeneration,
      });
    }
    if (completed.readCacheHit === null && _isReadTool(call.name)) {
      setReadCached({
        sessionId,
        args: call.arguments,
        cwd,
        content: result,
        toolUseId: call.id,
        readState: completed.readCacheState,
      });
    }
  }
  // A successful scoped lookup from before a later mutation is
  // intentionally not cached, but its per-call completeness record still
  // has to be reclaimed.
  if (scopedCacheable) outcomeMap?.delete(call.id);
}

function completedToolResult(completed, result, postprocessStartedAt) {
  const { call } = completed;
  // Both edit dialects publish the same per-call UI diff side channel:
  // apply_patch via registerCommittedPatchUiDiff, edit (and its foreign
  // str-replace aliases) via recordEditUiDiff.
  const uiDiff = MUTATION_UI_DIFF_TOOLS.has(_stripMcpPrefix(call.name)) ? takeApplyPatchUiDiff(call.id) : null;
  return {
    role: 'tool',
    content: result,
    toolCallId: call.id,
    toolKind: completed.resultKind,
    toolTiming: toolTiming(completed, postprocessStartedAt),
    ...(completed.nativeToolSearch ? { nativeToolSearch: completed.nativeToolSearch } : {}),
    ...(uiDiff !== null ? { uiDiff } : {}),
  };
}

function noteEditProgress(batch) {
  batch.crossTurnCalls.clear();
  batch.editCount += 1;
}

function recordCrossTurn(batch, completed) {
  const { call } = completed;
  const { tools, crossTurnCalls } = batch;
  if (isToolCallDedupEligible(call.name, tools)) {
    const sig = completed.crossTurnSig ?? crossTurnSignature(call.name, call.arguments);
    if (!crossTurnCalls.has(sig)) {
      crossTurnCalls.set(sig, { count: 1, firstIteration: batch.iterations });
      if (crossTurnCalls.size > batch.crossTurnCap) {
        crossTurnCalls.delete(crossTurnCalls.keys().next().value);
      }
    }
  } else if (!isEagerDispatchable(call.name, tools) && isEditProgressTool(call.name, false)) {
    noteEditProgress(batch);
  }
}

function stagePostProcessingFailure(batch, completed, postErr, postprocessStartedAt) {
  const { call } = completed;
  const { sessionRef, tools } = batch;
  if (completed.executeOk && !isEagerDispatchable(call.name, tools) && isEditProgressTool(call.name, false)) {
    noteEditProgress(batch);
  }
  if (sessionRef?._scopedCacheOutcomeByCallId instanceof Map && call?.id) {
    sessionRef._scopedCacheOutcomeByCallId.delete(call.id);
  }
  if (call?.id) restoreToolCallBodyForId(batch.assistantTurnMsg, batch.calls, call.id);
  const message = `Error: tool result post-processing failed for "${call.name}": ${postErr instanceof Error ? postErr.message : String(postErr)}`;
  traceAgentToolFailure({
    sessionId: batch.sessionId,
    iteration: batch.iterations,
    toolName: call.name,
    toolKind: completed.toolKind,
    toolMs: completed.toolEndedAt && completed.toolStartedAt ? completed.toolEndedAt - completed.toolStartedAt : null,
    toolArgs: call.arguments,
    agent: sessionRef?.agent || null,
    model: batch.turnModel,
    cwd: batch.cwd,
    resultText: message,
    resultKind: 'error',
  });
  stageToolResult(batch, {
    role: 'tool',
    content: message,
    toolCallId: call.id,
    toolKind: 'error',
    toolTiming: toolTiming(completed, postprocessStartedAt),
  });
}
