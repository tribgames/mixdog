import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { repairUsageLedger } from './usage-ledger-repair.mjs';

test('repricing keeps the ingestion pricing rule: live records keep their exact request time, imports do not', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const ts = Date.UTC(2026, 0, 3, 12);
  const row = (id, origin) =>
    makeUsageRecord({
      id,
      ts,
      provider: 'deepseek',
      model: 'no-such-model-for-repair',
      sessionId: id,
      inputTokens: 1000,
      outputTokens: 10,
      origin,
    });
  ledger.record([row('live-row', 'live'), row('trace-row', 'trace')]);
  const historical = [];
  repairUsageLedger(ledger, {
    throughTs: ts + 1,
    onlyUnpriced: true,
    price: (args) => {
      historical.push(args.historical);
      return { costUsd: 1, rates: {} };
    },
  });
  assert.deepEqual(historical.sort(), [false, true]);
});
