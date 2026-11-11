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
  const quietInput = { progressAt: since, stage: 'tool_running', tool: 'shell', now: since + 180_000 };
  const quiet = q.quietProgress(quietInput);
  const partsAt = { early: since + 180_000, late: since + warnMs, nullParts: since };
  const early = q.quietProgressParts(quiet, partsAt.early, warnMs);
  const late = q.quietProgressParts(quiet, partsAt.late, warnMs);
  const noWarnInput = { quiet: { since, wait: 'provider' }, now: since + 125_000 };
  const noWarn = q.quietProgressParts(noWarnInput.quiet, noWarnInput.now);
  return { quietInput, quiet, warnMs, partsAt, early, earlyLabel: q.quietProgressLabel(early), late, nullParts: q.quietProgressParts(null, partsAt.nullParts, warnMs), noWarnInput, noWarn, noWarnLabel: q.quietProgressLabel(noWarn) };
});
await set.run('a sent request waiting for its headers is the model-thinking stage until transport arrives', () => {
  const sent = { stage: 'requesting', requestSentAt: 100, lastTransportAt: 0 };
  const stage = (input) => ({ input, awaiting: q.awaitingModelResponse(input), displayStage: q.displayProgressStage(input) });
  const thinkingInput = { quiet: { since: 1, wait: 'thinking' }, now: 1 + 125_000 };
  const thinking = q.quietProgressParts(thinkingInput.quiet, thinkingInput.now);
  const sentRow = { sessionId: 'run', agent: 'worker', status: 'running' };
  const sentEntry = { ...sent, controller: {}, lastProgressAt: 90 };
  const [row] = withTurnProgress([sentRow], () => sentEntry, isTurnInFlight);
  return {
    thinkingInput,
    sentRow,
    sentEntry,
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
    entry: 'The quiet state a turn publishes (Node tui/session/turn-quiet.mjs turnQuietState over shared/quiet-progress.mjs, run by the lead turn, turn.mjs:781) is the core\'s: mixdog-core-agents agents/quiet_progress.rs (quiet_progress, quiet_wait_kind, last_progress_at, awaiting_model_response, display_progress_stage, turn_quiet_state), published as spinner.quiet by mixdog-core run_host/quiet_watch.rs QuietWatch (started in factory.rs for an attended turn); the pool rows read the same stamps (pool_list.rs with_progress, the last step of AgentPool::list). The labels are the client\'s: the desktop renders spinner.quiet through src/tui/spinner-meta.mjs buildSpinnerMeta (quietProgressParts :78, quietProgressLabel :95; apps/desktop/src/renderer/transcript-status.tsx:24 and :528).',
    missingOnO1: [],
    compare: 'Cases 0-4 in mixdog-core-agents agents/pool_list_quiet_replay.rs: each recorded input fed to the core, the core\'s values written to src/tui/quiet-progress-core.json; src/tui/quiet-progress-replay.test.mjs feeds the core\'s quiet states to buildSpinnerMeta and compares each case whole with this recording (one chain: recorded input -> core -> client -> recorded value).',
  },});
process.exit(0);
