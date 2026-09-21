// Eager tool-dispatch controller. Owns the
// per-turn pending promise map and the mutation epoch. Every valid call
// dispatches while the provider is still streaming. Calls execute in parallel
// except that repository-wide Git writes serialize against file edits, while
// shell waits for every earlier mutation; results are collected later in call
// order. Admission gates, ordering barriers and the per-entry run live under
// ./eager-dispatch/.
import { createEagerAdmission } from './eager-dispatch/admission.mjs';
import { createEagerBarriers } from './eager-dispatch/barriers.mjs';
import { createEagerEntry, runEagerEntry } from './eager-dispatch/entry.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { isParallelDispatchable } from './loop/tool-helpers.mjs';

export function createEagerDispatcher({
  tools,
  cwd,
  sessionId,
  sessionRef,
  signal,
  opts,
  crossTurnCalls,
  getIterations,
  getNextIteration,
  repeatFailLimit,
  executeToolFn = executeTool,
}) {
  const pending = new Map();
  const epoch = { mutation: 0 };
  const admission = createEagerAdmission({
    tools,
    cwd,
    sessionId,
    sessionRef,
    crossTurnCalls,
    getIterations,
    repeatFailLimit,
  });
  const barriers = createEagerBarriers({ cwd });
  const execute = (call, entry) =>
    executeToolFn(call.name, call.arguments, cwd, sessionId, sessionRef, {
      toolCallId: call.id,
      signal,
      notifyFn: opts.notifyFn,
      toolApprovalHook: opts.onToolApproval,
      iteration: getNextIteration(),
      localSearchTelemetry: entry.localSearchTelemetry,
      resultTelemetry: entry.resultTelemetry,
    });

  const startEagerTool = (call) => {
    if (!call?.id || pending.has(call.id) || !isParallelDispatchable(call.name)) return null;
    const admitted = admission.admit(call);
    if (!admitted) return null;
    const entry = createEagerEntry({ mutationEpoch: epoch.mutation });
    const preceding = barriers.precedingFor(call);
    admission.markInFlight(call, admitted);
    entry.promise = runEagerEntry({
      call,
      entry,
      preceding,
      waitForPreceding: barriers.waitForPreceding,
      execute,
      opts,
      sessionId,
      cwd,
    });
    pending.set(call.id, entry);
    barriers.register(call, entry, preceding);
    return entry;
  };
  const startEagerRun = (calls, startIndex, dupSet) => {
    for (let j = startIndex; j < calls.length; j += 1) {
      const call = calls[j];
      if (!call?.id || !isParallelDispatchable(call.name)) continue;
      if (dupSet?.has(call.id)) continue;
      // Admission skips are not ordering barriers: later independent calls
      // must still start after a dedup, denial, invalid-args, or cache stub.
      startEagerTool(call);
    }
  };
  const onToolCall = (call) => {
    startEagerTool(call);
  };
  return { pending, epoch, startEagerTool, startEagerRun, onToolCall };
}
