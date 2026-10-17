import assert from 'node:assert/strict';
import test from 'node:test';

import { QUIET_PROGRESS_CUE_MS } from '../../runtime/shared/quiet-progress.mjs';
import { buildSpinnerMeta } from '../spinner-meta.mjs';
import { startQuietWatch, turnQuietState } from './turn-quiet.mjs';

test('a quiet lead turn publishes one frozen quiet state per silence and clears it when progress resumes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 10_000_000 });
  let liveness = { stage: 'requesting', askStartedAt: Date.now(), lastProgressAt: Date.now() };
  let state = { spinner: { active: true, mode: 'requesting' } };
  const writes = [];
  const stop = startQuietWatch({
    runtime: { getTurnLiveness: () => liveness },
    getState: () => state,
    set: (patch) => {
      writes.push(patch.spinner.quiet);
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
    warnMs: 600_000,
  });
  t.mock.timers.tick(QUIET_PROGRESS_CUE_MS - 1_000);
  assert.deepEqual(writes, [], 'not quiet inside the cue window');
  t.mock.timers.tick(5_000);
  const since = liveness.lastProgressAt;
  assert.deepEqual(writes, [{ since, wait: 'provider', warnMs: 600_000 }]);
  t.mock.timers.tick(30_000);
  assert.equal(writes.length, 1, 'the frozen state is published once');
  liveness = { ...liveness, stage: 'streaming', lastStreamDeltaAt: Date.now() };
  t.mock.timers.tick(1_000);
  assert.deepEqual(writes, [{ since, wait: 'provider', warnMs: 600_000 }, null]);
  stop();
});

test('the shared byline reads the quiet state the same way on every surface', () => {
  const now = 50_000_000;
  const quiet = turnQuietState({ stage: 'streaming', lastProgressAt: now - 400_000 }, now, 300_000);
  const meta = buildSpinnerMeta({ quiet, now });
  assert.equal(meta.quietText, 'quiet for 6m · waiting on model');
  assert.equal(meta.quietParts.escalated, true);
  assert.equal(buildSpinnerMeta({ now }).quietText, '');
  // A sent request still waiting for its headers: the model is thinking.
  const thinking = turnQuietState(
    { stage: 'requesting', requestSentAt: now - 200_000, lastTransportAt: 0, lastProgressAt: now - 200_000 },
    now,
    300_000
  );
  assert.equal(buildSpinnerMeta({ quiet: thinking, now }).quietText, 'quiet for 3m · model thinking');
  // A wire-only (async) liveness answer is not evidence of a silence.
  assert.equal(turnQuietState(Promise.resolve({}), now, 300_000), null);
});
