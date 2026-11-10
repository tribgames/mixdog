import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sweepStaleSessions } from './stale-sweep.mjs';

test('sweeping a store whose dir is missing returns the full result shape', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sweep-missing-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const result = await sweepStaleSessions(60_000);
  assert.equal(result.cleaned, 0);
  assert.equal(result.openPruned, 0);
  assert.deepEqual(result.openPrunedDetails, []);
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.tombstoneDetails, []);
  assert.equal('openCandidates' in result, false);
});
