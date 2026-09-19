// Tool-call batch processor: the whole per-assistant-turn tool phase.
// Pre-pass planning (tool-batch/plan), the serial call loop (pre-dispatch
// guards → eager-result collection or serial execution → outcome
// bookkeeping), batch finalization (offload, trace, cache, staged results)
// and the ordered flush with the PostToolBatch hook. Mutable counters
// (dedupStubTotal/editCount) are threaded in/out; crossTurnCalls / epoch /
// pending mutate by reference.
import { canonicalizeBuiltinToolName, isBuiltinTool } from '../tools/builtin.mjs';
import { createBatchState, stageToolResult } from './tool-batch/state.mjs';
import { preDispatchSkip } from './tool-batch/pre-dispatch.mjs';
import { executeBatchCall } from './tool-batch/execute-call.mjs';
import { recordCallOutcome } from './tool-batch/record-outcome.mjs';
import { finalizeBatchResults } from './tool-batch/finalize.mjs';
import { flushBatch } from './tool-batch/flush.mjs';

export async function processToolBatch(ctx) {
  const batch = createBatchState(ctx);
  const { calls, throwIfAborted } = batch;
  for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
    const call = calls[callIndex];
    if (isBuiltinTool(call.name)) call.name = canonicalizeBuiltinToolName(call.name);
    const { skip, ctSig, sigs } = preDispatchSkip(batch, call);
    if (skip !== null) {
      stageToolResult(batch, skip);
      continue;
    }
    const exec = await executeBatchCall(batch, call, callIndex);
    await recordCallOutcome(batch, call, exec, sigs, ctSig);
    // Soft-cancel after each tool: if close landed during execution,
    // discard the rest of the batch and skip the next provider.send.
    throwIfAborted();
  }
  await finalizeBatchResults(batch);
  await flushBatch(batch);
  return { dedupStubTotal: batch.dedupStubTotal, editCount: batch.editCount };
}
