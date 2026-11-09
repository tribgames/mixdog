// The context gauge helpers against what Node's own module (b6f10295a) answered for the same inputs
// (node-oracle/record.mjs): token counts, sources, percents and the null results of pending/unavailable readings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contextMeasurementStats, measuredContextUsage } from '../../src/rows/context-measurement.mjs';
import { CONTEXT_MEASUREMENT } from './node-oracle/cases.mjs';

const golden = JSON.parse(readFileSync(new URL('./node-oracle/node-oracle.golden.json', import.meta.url), 'utf8'));

test('the golden is pinned to b6f10295a and covers every case', () => {
  assert.match(golden.recordedFrom, /^b6f10295a[0-9a-f]{31}$/);
  assert.equal(golden.ctx.length, CONTEXT_MEASUREMENT.length);
});

CONTEXT_MEASUREMENT.forEach(([kind, input, opts], index) => {
  test(`${kind} equals Node's: case ${index} ${JSON.stringify(input).slice(0, 60)}`, () => {
    const expected = golden.ctx[index].result;
    if (kind === 'usage') {
      assert.deepEqual(measuredContextUsage({ stats: input, ...opts }), expected.usage);
      return;
    }
    const stats = contextMeasurementStats(input);
    assert.deepEqual(stats, expected.stats);
    assert.deepEqual(measuredContextUsage({ stats, ...opts }), expected.usage);
  });
});
