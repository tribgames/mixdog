// Node's recording native/core/fixtures/quiet-progress-cases/golden.json (record-quiet-progress-cases.mjs at b6f10295a), cases
// 0-3: a turn's quiet state and the cue a client shows of it. One chain: the recorded inputs went through the core
// (mixdog-core-agents `agents::pool_list::quiet_replay`: the quiet state, the published `spinner.quiet`, the stage and progress
// reads and the pool row), whose output is quiet-progress-core.json; here the desktop's `buildSpinnerMeta` (the component
// transcript-status.tsx renders `spinner.quiet` through) turns the core's published state into the cue's parts and label, and
// each case is compared whole, in recorded key order, with the recording.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exact } from '../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { buildSpinnerMeta } from './spinner-meta.mjs';

const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const golden = read(new URL('../../native/core/fixtures/quiet-progress-cases/golden.json', import.meta.url));
const core = read(new URL('quiet-progress-core.json', import.meta.url));

function recorded(index, name) {
  const c = golden.cases[index];
  assert.equal(c.case, name, `case ${index}`);
  return c.observed;
}

/** Whole and in order: the encoded value equals the recording. */
function same(got, want, what) {
  const encoded = exact(got);
  assert.deepStrictEqual(encoded, want, what);
  assert.equal(JSON.stringify(encoded), JSON.stringify(want), `${what}: key order`);
}

/** The client's cue of a quiet state at `now`. */
const cue = (quiet, now) => buildSpinnerMeta({ quiet, now });

test('case 0: the quiet cue is lenient', () => {
  const want = recorded(0, 'the quiet cue is lenient: a turn reads quiet only after the cue window without counted progress');
  const c = core['0'];
  same(
    {
      cueWindowMs: c.cueWindowMs,
      quietProgress: want.quietProgress.map(({ input }, i) => ({ input, result: c.quietProgress[i] })),
      quietWaitKind: want.quietWaitKind.map(({ stage }, i) => ({ stage, kind: c.quietWaitKind[i] })),
    },
    want,
    'case 0',
  );
});

test('case 1: the published quiet state is frozen for a silence and its cue escalates at the warn point', () => {
  const want = recorded(1, 'the quiet state is frozen for a silence and escalates only at the watchdog warn point');
  const published = core['1'].published;
  const { warnMs, ...quiet } = published;
  const early = cue(published, want.partsAt.early);
  const late = cue(published, want.partsAt.late);
  const noWarn = cue(want.noWarnInput.quiet, want.noWarnInput.now);
  same(
    {
      quietInput: want.quietInput,
      quiet,
      warnMs,
      partsAt: want.partsAt,
      early: early.quietParts,
      earlyLabel: early.quietText,
      late: late.quietParts,
      nullParts: cue(null, want.partsAt.nullParts).quietParts,
      noWarnInput: want.noWarnInput,
      noWarn: noWarn.quietParts,
      noWarnLabel: noWarn.quietText,
    },
    want,
    'case 1',
  );
});

test('case 2: a sent request waiting for its headers reads model thinking', () => {
  const want = recorded(2, 'a sent request waiting for its headers is the model-thinking stage until transport arrives');
  const c = core['2'];
  same(
    {
      thinkingInput: want.thinkingInput,
      sentRow: want.sentRow,
      sentEntry: want.sentEntry,
      modelThinkingStage: c.modelThinkingStage,
      stages: want.stages.map(({ input }, i) => ({ input, awaiting: c.stages[i].awaiting, displayStage: c.stages[i].displayStage })),
      waitKindOfThinking: c.waitKindOfThinking,
      thinkingLabel: cue(want.thinkingInput.quiet, want.thinkingInput.now).quietText,
      poolRowFromSentEntry: c.poolRowFromSentEntry,
    },
    want,
    'case 2',
  );
});

test('case 3: progress is counted from the stall watchdog stamps', () => {
  const want = recorded(3, 'progress is counted from the same stamps as the stall watchdog');
  same({ stamps: want.stamps, lastProgressAt: core['3'].lastProgressAt, nullEntry: core['3'].nullEntry }, want, 'case 3');
});
