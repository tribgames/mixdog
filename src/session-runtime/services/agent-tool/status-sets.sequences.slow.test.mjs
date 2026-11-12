import '../../../../scripts/lib/isolated-test-env.mjs';
import test from 'node:test';

const { world, runSequence } = await import('./status-fixture.test-helpers.mjs');

// 2,000 seeded sequences (~90 ms each, so ~3 min: the slow lane) of every source event (status-fixture events), each
// on a freshly populated small world (the previous one's Leads purged, so its
// scopes end too); every step compared with the read before the status sets.
// MIXDOG_STATUS_SEQUENCES picks another count, MIXDOG_STATUS_SEED one seed.
const SEQUENCES = Number(process.env.MIXDOG_STATUS_SEQUENCES) || 2_000;
const ONLY = Number(process.env.MIXDOG_STATUS_SEED) || 0;
const STEPS = 12;

test(`${ONLY ? `seed ${ONLY}` : `${SEQUENCES} seeded sequences`}: every answer equals the read before the status sets after every event`, async (t) => {
  const w = await world(t, { seed: 1, rows: 4, tombstones: 2, leads: 1, tagOnly: 1, tasks: 1 });
  const seeds = ONLY ? [ONLY] : Array.from({ length: SEQUENCES }, (_, i) => i + 1);
  for (const seed of seeds) {
    const populate = {
      seed,
      rows: 6 + (seed % 9),
      tombstones: seed % 7,
      leads: 1 + (seed % 3),
      tagOnly: seed % 4,
      tasks: seed % 5,
      notReady: seed % 13 === 0,
    };
    try {
      await runSequence(t, w, STEPS, `seed ${seed}`, populate);
    } catch (error) {
      error.message = `failing seed ${seed} (MIXDOG_STATUS_SEED=${seed}): ${error.message}`;
      throw error;
    }
  }
});
