// Per-batch state shared by the tool-batch phases: the loop's context, the
// pre-pass plan, and the buffers the phases fill before the ordered flush.
// The counters the loop threads across batches (dedupStubTotal/editCount)
// live here so processToolBatch can hand them back.
import { executeTool } from '../loop/tool-exec.mjs';
import { planToolBatch } from './plan.mjs';

export function createBatchState(ctx) {
  const { calls, tools, assistantTurnMsg, sessionRef } = ctx;
  return {
    calls,
    messages: ctx.messages,
    tools,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    sessionRef,
    signal: ctx.signal,
    opts: ctx.opts,
    iterations: ctx.iterations,
    assistantTurnMsg,
    pending: ctx.pending,
    epoch: ctx.epoch,
    startEagerRun: ctx.startEagerRun,
    crossTurnCalls: ctx.crossTurnCalls,
    crossTurnCap: ctx.crossTurnCap,
    sessionAgent: ctx.sessionAgent,
    pushToolResultMessage: ctx.pushToolResultMessage,
    throwIfAborted: ctx.throwIfAborted,
    repeatFailLimit: ctx.repeatFailLimit,
    toolBatchId: ctx.toolBatchId,
    executeToolFn: typeof ctx.executeToolFn === 'function' ? ctx.executeToolFn : executeTool,
    dedupStubTotal: ctx.dedupStubTotal,
    editCount: ctx.editCount,
    turnModel: assistantTurnMsg?.meta?.transcript?.model || sessionRef?.model || null,
    plan: planToolBatch(calls, tools),
    // General `newMessages` tool-result channel: a tool MAY return a
    // `{ __toolEnvelope, result, newMessages }` envelope whose newMessages
    // (e.g. a Skill body as a role:'user' message) are collected across
    // EVERY call and flushed ONCE after the batch's last tool_result —
    // never interleaved between two tool results of the same turn.
    newMessages: [],
    // Executed calls, finalized together so the message-level output budget
    // can select the largest non-Read results before cache/history/UI see
    // any body.
    completed: [],
    resultByCallId: new Map(),
    resultsWithoutId: [],
  };
}

export function stageToolResult(batch, message) {
  if (message?.toolCallId) batch.resultByCallId.set(message.toolCallId, message);
  else batch.resultsWithoutId.push(message);
}
