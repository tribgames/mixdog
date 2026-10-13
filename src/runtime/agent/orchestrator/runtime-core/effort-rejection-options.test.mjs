import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'effort-options-'));
process.env.MIXDOG_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { effortOptionsFor, coerceEffortFor } = await import('./effort.mjs');
const { recordEffortRejection } = await import('../providers/effort-rejection.mjs');

const ladder = [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }];

test('levels an endpoint rejected stop being offered for that route only', () => {
  const contributor = { id: 'muse-spark-1.3-contributor', reasoningOptions: ladder };
  assert.deepEqual(effortOptionsFor('muse-code-oauth', contributor), ladder[0].values);

  recordEffortRejection('muse-code-oauth', 'muse-spark-1.3-contributor', 'max');

  assert.deepEqual(effortOptionsFor('muse-code-oauth', contributor), ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(coerceEffortFor('muse-code-oauth', contributor, 'max'), 'xhigh');
  // Same model on another route, and another model on the same route, are untouched.
  assert.deepEqual(effortOptionsFor('opencode-go', contributor), ladder[0].values);
  assert.deepEqual(
    effortOptionsFor('muse-code-oauth', { id: 'muse-spark-1.3', reasoningOptions: ladder }),
    ladder[0].values
  );
});
