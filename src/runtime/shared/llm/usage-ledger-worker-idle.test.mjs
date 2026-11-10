import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

// Short idle period for the test; read when usage-ledger.mjs loads.
const IDLE_MS = 150;
process.env.MIXDOG_USAGE_LEDGER_WORKER_IDLE_MS = String(IDLE_MS);
const { UsageLedger, makeUsageRecord, usageLedgerWorkerRunning } = await import('./usage-ledger.mjs');
const { rollupUsage } = await import('./usage-ledger-rollup.mjs');

const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-worker-idle-'));
const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
after(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;
const row = () =>
  makeUsageRecord({
    ts: Date.now(),
    provider: 'openai',
    model: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 1,
    responseId: `idle-${seq++}`,
  });
const count = () => ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n;

async function waitForIdleExit() {
  const deadline = Date.now() + 5000;
  while (usageLedgerWorkerRunning()) {
    assert.ok(Date.now() < deadline, 'the idle worker never exited');
    await sleep(20);
  }
}

test('the ledger worker exits when idle and restarts for the next write or rollup', async () => {
  await Promise.all(Array.from({ length: 20 }, () => ledger.recordQueued(row())));
  assert.equal(usageLedgerWorkerRunning(), true);
  assert.equal(count(), 20);
  await waitForIdleExit();

  // Next write restarts it.
  await ledger.recordQueued(row());
  assert.equal(count(), 21);
  await waitForIdleExit();

  // Next rollup of a changed ledger restarts it with an identical answer.
  const rolled = await ledger.rollupAsync();
  assert.deepEqual(rolled, rollupUsage(ledger.db, {}));
  await waitForIdleExit();
  // An unchanged ledger is still answered from the cache, with no worker.
  assert.equal(await ledger.rollupAsync(), rolled);
  assert.equal(usageLedgerWorkerRunning(), false);
});

test('writes queued around idle retirements are never lost or reordered', async () => {
  const before = count();
  const settled = [];
  const writes = [];
  // Delays straddle the idle period so retirements fall between batches.
  for (const delay of [0, IDLE_MS - 20, IDLE_MS + 30, 5, IDLE_MS, 0, IDLE_MS + 60, 1]) {
    await sleep(delay);
    for (let index = 0; index < 3; index += 1) {
      const id = writes.length;
      writes.push(ledger.recordQueued(row()).then(() => settled.push(id)));
    }
  }
  await Promise.all(writes);
  await ledger.settleWrites();
  assert.equal(count(), before + writes.length);
  assert.deepEqual(
    settled,
    writes.map((_, index) => index),
    'queued writes settled out of order'
  );
  await waitForIdleExit();
});
