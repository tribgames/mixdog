import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { UsageLedger, makeUsageRecord, getUsageLedger, closeUsageLedgers } from './usage-ledger.mjs';
import { priceUsage } from './cost.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { importUsageHistory, importTraceRow } from './usage-ledger-import.mjs';
import { usageStatsSnapshot } from '../../../standalone/usage-stats-model.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const now = new Date(2026, 8, 12, 12).getTime();
const row = (extra = {}) =>
  makeUsageRecord({
    ts: now,
    provider: 'anthropic-oauth',
    model: 'claude-opus-4-8',
    sessionId: 'session',
    sourceType: 'lead',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    responseId: 'response',
    ...extra,
  });
function store(t) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}

test('tokens, list value, price snapshot and day totals commit exactly once', (t) => {
  const ledger = store(t);
  const event = row();
  assert.equal(event.costUsd, 0.014375); // .005 + .005 + .0025 + .001875
  assert.equal(event.costSource, 'subscription');
  assert.equal(event.rates.inputCostPerM, 5);
  assert.equal(ledger.record([event, { ...event }]), 1);
  const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now, source: 'all' });
  assert.equal(stats.totals.tokens, 6500);
  assert.equal(stats.totals.cacheTokens, 5300);
  assert.equal(stats.totals.costUsd, 0.014375);
  assert.equal(stats.totals.costBilled, 0);
  assert.equal(stats.totals.costCoverage, 1);
  assert.equal(stats.totals.cacheHitRate, 0.7937);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});

test('zero provider price is known, missing price is unknown, subscriptions never become bills', () => {
  assert.equal(row({ provider: 'openai', model: 'unpriced-test', costUsd: 0 }).costSource, 'provider');
  assert.equal(row({ provider: 'openai', model: 'unpriced-test' }).costUsd, null);
  assert.equal(row({ costUsd: 999 }).costUsd, 0.014375);
  assert.equal(row({ provider: 'mixdog-local', model: 'local-test' }).costUsd, 0);
});

test('inclusive input is normalized once, including a relay route', () => {
  const event = row({ provider: 'cursor-oauth', inputTokens: 6300, inputTokensInclusive: true });
  assert.equal(event.input, 1000);
  assert.equal(event.costUsd, 0.014375);
});

test('official context and UTC time tiers are priced at request granularity', () => {
  const grok = { provider: 'grok-oauth', model: 'grok-4.20', outputTokens: 1000 };
  assert.equal(priceUsage({ ...grok, inputTokens: 199999 }).costUsd, 0.252499);
  assert.equal(priceUsage({ ...grok, inputTokens: 200000 }).costUsd, 0.505);
  const deepseek = { provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 1_000_000 };
  assert.equal(priceUsage({ ...deepseek, ts: Date.parse('2026-09-11T06:00:00Z') }).costUsd, 0.3);
  assert.equal(priceUsage({ ...deepseek, ts: Date.parse('2026-09-11T10:00:00Z') }).costUsd, 0.15);
  assert.equal(priceUsage({ ...deepseek, ts: Date.parse('2026-09-12T06:00:00Z') }).costUsd, 0.15);
  assert.equal(priceUsage({ ...deepseek, ts: now, historical: true }).costUsd, 0.3);
  assert.equal(row({ fast: true }).costUsd, 0.02875);
});

test('years of history survive reopen with no TTL or session deletion dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-retention-'));
  const path = join(dir, 'ledger.sqlite');
  const first = new UsageLedger(path);
  first.record([row({ ts: new Date(2022, 0, 1).getTime() })]);
  first.close();
  const reopened = new UsageLedger(path);
  try {
    const stats = usageStatsSnapshot({ rollup: reopened.rollup(), now });
    assert.equal(stats.totals.tokens, 6500);
    assert.equal(stats.totals.costUsd, 0.014375);
    assert.equal(stats.range.firstDay, '2022-01-01');
  } finally {
    reopened.close();
  }
});

test('an invalid batch rolls back both originals and daily totals', (t) => {
  const ledger = store(t);
  assert.throws(() => ledger.record([row(), { ...row({ responseId: 'bad' }), model: undefined }]));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.deepEqual(ledger.rollup(), { days: {} });
});

test('a usage_events row with no daily index row contributes nothing instead of throwing', (t) => {
  const kept = row({ responseId: 'kept' });
  const orphan = row({ model: 'orphan-model', sessionId: 'orphan-session', responseId: 'orphan' });
  const reference = store(t);
  reference.record([kept]);
  const ledger = store(t);
  ledger.record([kept, orphan]);
  // `daily` is a derived index: dropping the orphan route's row leaves its
  // retained usage_events row without a matching day/route bucket. The
  // rollup must skip that row and report the remaining route's arithmetic
  // unchanged, rather than failing on the missing bucket.
  ledger.db.exec("DELETE FROM daily WHERE model='orphan-model'");
  assert.deepEqual(ledger.rollup(), reference.rollup());
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n, 2);
});

test('concurrent processes share one idempotent ledger without lost totals', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-usage-concurrent-')), 'ledger.sqlite');
  new UsageLedger(path).close();
  const moduleUrl = new URL('./usage-ledger.mjs', import.meta.url).href;
  const run = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        `
            (async () => {
                const { UsageLedger, makeUsageRecord } = await import(${JSON.stringify(moduleUrl)});
                const ledger = new UsageLedger(${JSON.stringify(path)});
                for (let i=0;i<20;i++) ledger.record([makeUsageRecord({
                    provider:'mixdog-local',model:'test',ts:${now},inputTokens:10,
                    outputTokens:2,responseId:'same-'+i
                })]);
                ledger.close();
            })().catch(e=>{ console.error(e); process.exitCode=1; });
        `,
        { eval: true }
      );
      worker.on('error', reject);
      worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
    });
  await Promise.all([run(), run()]);
  const ledger = new UsageLedger(path);
  try {
    const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now });
    assert.equal(stats.totals.turns, 20);
    assert.equal(stats.totals.tokens, 240);
  } finally {
    ledger.close();
  }
});

test('closeUsageLedgers releases the file so its directory can be removed, and later access reopens', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-close-'));
  const priorPath = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(dir, 'ledger.sqlite');
  t.after(() => {
    closeUsageLedgers();
    if (priorPath === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = priorPath;
  });
  const first = getUsageLedger();
  first.set('marker', 'open');
  assert.equal(getUsageLedger(), first, 'the store is shared while open');

  closeUsageLedgers();
  assert.throws(() => first.get('marker'), /closed|not open/i, 'the handle is really closed');
  // No retries: an open SQLite handle would make this EBUSY on Windows.
  rmSync(dir, { recursive: true, force: true, maxRetries: 0 });

  const reopened = getUsageLedger();
  assert.notEqual(reopened, first, 'access after close reopens a fresh store');
  assert.equal(reopened.get('marker'), null);
});

test('live provider accounting works with diagnostics disabled and retains cancellation', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-usage-capture-')), 'ledger.sqlite');
  const priorPath = process.env.MIXDOG_USAGE_LEDGER_PATH;
  const priorTrace = process.env.MIXDOG_AGENT_TRACE_DISABLE;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  t.after(() => {
    if (priorPath === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = priorPath;
    if (priorTrace === undefined) delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
    else process.env.MIXDOG_AGENT_TRACE_DISABLE = priorTrace;
  });
  const result = { model: 'claude-opus-4-8', responseId: 'live', usage: { inputTokens: 1000, outputTokens: 200 } };
  const instance = { constructor: { inputExcludesCache: true } };
  assert.equal(
    await accountProviderSend(
      'anthropic-oauth',
      instance,
      async () => {
        assert.ok(getUsageLedger().get('liveSince'), 'cutover must precede the request and its diagnostic copy');
        return result;
      },
      result.model,
      { sessionId: 'live-session', session: { sourceType: 'lead' } }
    ),
    result
  );
  const cancel = new Error('cancelled');
  await assert.rejects(
    accountProviderSend(
      'anthropic-oauth',
      instance,
      async () => {
        throw cancel;
      },
      result.model
    ),
    (error) => error === cancel
  );
  const ledger = new UsageLedger(path);
  try {
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    assert.equal(ledger.db.prepare('SELECT cost_source FROM events').get().cost_source, 'subscription');
  } finally {
    ledger.close();
  }
  // An unavailable accounting destination must neither replay the provider
  // request nor erase the successful response.
  process.env.MIXDOG_USAGE_LEDGER_PATH = mkdtempSync(join(tmpdir(), 'mixdog-usage-unwritable-'));
  const messages = [];
  t.mock.method(process.stderr, 'write', (text) => {
    messages.push(String(text));
    return true;
  });
  let calls = 0;
  const unsaved = { ...result };
  assert.equal(
    await accountProviderSend(
      'anthropic-oauth',
      instance,
      async () => {
        calls++;
        return unsaved;
      },
      result.model
    ),
    unsaved
  );
  assert.equal(calls, 1);
  assert.equal(typeof unsaved.usageAccountingError, 'string');
  assert.equal(
    messages.some((line) => line.includes('RECORD NOT SAVED')),
    true
  );
});

test('corrupt historical data is an import failure, not a successful empty history', async (t) => {
  const ledger = store(t);
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-corrupt-'));
  writeFileSync(join(dir, 'gateway-usage.local.json'), '{broken');
  await assert.rejects(importUsageHistory(ledger, dir, { now, readTrace: async () => [] }), SyntaxError);
  assert.equal(ledger.get('importedThrough'), null);
});

test('import skips blank PG usage fields, deduplicates raw copies, preserves originals and source precedence', async (t) => {
  const ledger = store(t);
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-import-'));
  const original = JSON.stringify({
    events: [
      {
        ts: now - 11000,
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        sessionId: 's',
        inputTokens: 10000,
        outputTokens: 100,
        costUsd: 99,
      },
    ],
  });
  const path = join(dir, 'gateway-usage.local.json');
  writeFileSync(path, original);
  const raw = {
    kind: 'usage_raw',
    ts: now - 12000,
    model: 'claude-opus-4-8',
    session_id: 's',
    input_tokens: 1000,
    output_tokens: 200,
    cached_tokens: 0,
    cache_write_tokens: 0,
    payload: { provider: 'anthropic-oauth', response_id: 'original', uncached_input_tokens: 1000 },
  };
  assert.equal(importTraceRow({ kind: 'usage', model: raw.model, input_tokens: null, payload: {} }), null);
  const first = await importUsageHistory(ledger, dir, { now, readTrace: async () => [raw, raw] });
  assert.equal(first.inserted, 2); // one raw request and one separate, overlapping terminal summary
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(
    await importUsageHistory(ledger, dir, {
      now,
      readTrace: async () => {
        throw new Error('must not read');
      },
    }),
    { skipped: true }
  );
  const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now });
  assert.equal(stats.totals.tokens, 1200); // not 11,300; the terminal summary is not added again
  assert.equal(stats.coverage.partialDays, 1);
});

test('API uses the ledger and reports a failed historical import instead of zero usage', async (t) => {
  const ledger = store(t);
  ledger.record([row()]);
  let imports = 0;
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {
      imports++;
      ledger.set('importedThrough', Number.MAX_SAFE_INTEGER);
    },
  });
  assert.equal((await api.getUsageStats()).totals.tokens, 6500);
  assert.equal((await api.getUsageStats()).coverage.ledger, true);
  assert.equal(imports, 1);
  const failure = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(failure.getUsageStats(), /offline/);
});

test('seven calendar days and the previous window have no overlap or wrong divisor', (t) => {
  const ledger = store(t);
  for (let i = 0; i < 15; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    ledger.record([row({ ts: date.getTime(), responseId: `day-${i}` })]);
  }
  const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now, days: 7 });
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.totals.turns, 7);
  assert.equal(stats.previous.turns, 7);
  assert.equal(stats.totals.costPerDay, 0.014375);
  assert.equal(usageStatsSnapshot({ rollup: ledger.rollup(), now, days: 0 }).previous, null);
});
