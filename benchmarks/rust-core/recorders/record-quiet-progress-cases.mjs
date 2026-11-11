#!/usr/bin/env node
// Recording of shared/quiet-progress.test.mjs (b6f10295a): the quiet-cue helpers (shared/quiet-progress.mjs) and the pool
// rows that carry a turn's progress (agent-pool-progress.mjs withTurnProgress), driven with the test's stamps.
//   node benchmarks/rust-core/recorders/record-quiet-progress-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('quiet-progress-cases', import.meta.url);
const q = await set.load('src/runtime/shared/quiet-progress.mjs');
const { withTurnProgress } = await set.load('src/runtime/agent/orchestrator/session/agent-pool-progress.mjs');
const { isTurnInFlight } = await set.load('src/runtime/agent/orchestrator/session/manager/runtime-state.mjs');
const { resolveAgentStallThresholds } = await set.load('src/runtime/agent/orchestrator/stall-policy.mjs');

await set.run('the quiet cue is lenient: a turn reads quiet only after the cue window without counted progress', () => {
  const now = 1_000_000_000;
  const call = (input) => ({ input, result: q.quietProgress(input) });
  return {
    cueWindowMs: q.QUIET_PROGRESS_CUE_MS,
    quietProgress: [
      call({ progressAt: now - q.QUIET_PROGRESS_CUE_MS + 1, stage: 'streaming', now }),
      call({ progressAt: now - q.QUIET_PROGRESS_CUE_MS, stage: 'requesting', now }),
      call({ progressAt: 0, stage: 'requesting', now }),
    ],
    quietWaitKind: ['tool_running', 'resource_wait', 'idle'].map((stage) => ({ stage, kind: q.quietWaitKind(stage) })),
  };
});
await set.run('the quiet state is frozen for a silence and escalates only at the watchdog warn point', () => {
  const since = 1_000;
  const warnMs = 300_000;
  const quiet = q.quietProgress({ progressAt: since, stage: 'tool_running', tool: 'shell', now: since + 180_000 });
  const early = q.quietProgressParts(quiet, since + 180_000, warnMs);
  const late = q.quietProgressParts(quiet, since + warnMs, warnMs);
  const noWarn = q.quietProgressParts({ since, wait: 'provider' }, since + 125_000);
  return { quiet, warnMs, early, earlyLabel: q.quietProgressLabel(early), late, nullParts: q.quietProgressParts(null, since, warnMs), noWarn, noWarnLabel: q.quietProgressLabel(noWarn) };
});
await set.run('a sent request waiting for its headers is the model-thinking stage until transport arrives', () => {
  const sent = { stage: 'requesting', requestSentAt: 100, lastTransportAt: 0 };
  const stage = (input) => ({ input, awaiting: q.awaitingModelResponse(input), displayStage: q.displayProgressStage(input) });
  const thinking = q.quietProgressParts({ since: 1, wait: 'thinking' }, 1 + 125_000);
  const [row] = withTurnProgress([{ sessionId: 'run', agent: 'worker', status: 'running' }], () => ({ ...sent, controller: {}, lastProgressAt: 90 }), isTurnInFlight);
  return {
    modelThinkingStage: q.MODEL_THINKING_STAGE,
    stages: [sent, { ...sent, lastTransportAt: 50 }, { ...sent, lastTransportAt: 150 }, { stage: 'requesting', requestSentAt: 0 }, { ...sent, stage: 'streaming' }].map(stage),
    waitKindOfThinking: q.quietWaitKind(q.MODEL_THINKING_STAGE),
    thinkingLabel: q.quietProgressLabel(thinking),
    poolRowFromSentEntry: row,
  };
});
await set.run('progress is counted from the same stamps as the stall watchdog', () => ({
  stamps: { lastProgressAt: 5, lastStreamDeltaAt: 9, toolStartedAt: 7, askStartedAt: 1 },
  lastProgressAt: q.lastProgressAt({ lastProgressAt: 5, lastStreamDeltaAt: 9, toolStartedAt: 7, askStartedAt: 1 }),
  nullEntry: q.lastProgressAt(null),
}));
await set.run('running pool rows carry their turn progress, stage and warn point; settled rows pass through', () => {
  const entry = { stage: 'tool_running', lastToolCall: 'shell', lastProgressAt: 50, toolStartedAt: 40, controller: {} };
  const rows = [{ sessionId: 'run', agent: 'worker', status: 'running' }, { sessionId: 'rest', agent: 'worker', status: 'idle' }];
  const decorated = withTurnProgress(rows, (sessionId) => (sessionId === 'run' ? entry : { stage: 'idle' }), isTurnInFlight);
  return { entry, rows, decorated, settledRowIsTheSameObject: decorated[1] === rows[1], workerWarnSeconds: resolveAgentStallThresholds('worker').warn };
});
await set.finish({
  entry: { runs: 'shared/quiet-progress.mjs (quietProgress, quietWaitKind, quietProgressParts, quietProgressLabel, awaitingModelResponse, displayProgressStage, lastProgressAt), withTurnProgress over isTurnInFlight, resolveAgentStallThresholds', notRun: 'the pool listing itself: the rows and the entry lookup are the test\'s' },
  replay: {
    entry: 'The pool-row decoration (withTurnProgress: progress time, display stage, running tool, stall warn) has a Rust counterpart, AgentPool::list; the quiet cue (quietProgress / quietProgressParts / quietWaitKind, labels such as "quiet for 3m · running shell", the cue window, the freeze until the watchdog warn point) has none: a search of native/**/*.rs for those names finds none, and agent_tool/progress.rs progress_fields (:380) is a different contract (task progress). The cue is new Rust work; this recording is its contract: feed each recorded input and compare the result whole.',
    nearestOnO1: 'only the model-thinking stage exists: mixdog-core-run run_host/progress.rs MODEL_THINKING_STAGE (:68) and awaiting_model_response (:396), and mixdog-core-agents agents/pool_list.rs:820 (progressStage "model_thinking"): they cover the stage-name part of the third case, not the cue, the labels or the pool-row decoration',
    note: 'also compares packages/protocol-client/src/rows/quiet-progress.mjs, the JS copy, on the same inputs',
  },});
process.exit(0);
