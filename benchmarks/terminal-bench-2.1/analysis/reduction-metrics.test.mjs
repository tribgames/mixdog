import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { summarizeReductionTraceRows } from './reduction-metrics.mjs';

// Recorded from the Node core's summarizeReductionTraceRows (src/runtime/agent/orchestrator/session/reduction-metrics.mjs)
// over the rows of each case: every row kind with its fields at the top level and under `payload`, rows that are
// not objects, and inputs that are not row arrays.
const cases = JSON.parse(readFileSync(new URL('./reduction-metrics.golden.json', import.meta.url), 'utf8'));

for (const { name, rows, expected } of cases) {
  test(`the port summarizes as the Node core did: ${name}`, () => {
    assert.deepEqual(summarizeReductionTraceRows(rows), expected);
  });
}
