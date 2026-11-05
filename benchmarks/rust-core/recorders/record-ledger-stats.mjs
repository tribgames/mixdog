#!/usr/bin/env node
// Golden twin of today's Node usage *service* queries over the usage ledger: the statistics
// period (resolveUsageStatsPeriod), getUsageStats, getUsageRequests (page envelope) and
// getQuotaHistory (history and window pages) of src/session-runtime/usage-stats-api.mjs, run
// unmodified except for its two write-side imports (history import and price refresh), over
// three ledgers: the genuine 1.4.5 fixture, the dev-shaped corpus ledger (with its real quota
// readings) and the 1.4.5 fixture with prices and synthetic quota readings added by
// `prepareSql` and `quotaSeeds`. The Rust ledger applies the same prepare/seed steps to its own
// upgrade of the same file and must produce the same bytes (key order included).
//
//   node benchmarks/rust-core/recorders/record-ledger-stats.mjs [--tree C:/Project/mixdog] [--corpus <migration-corpus>]
// Day keys and local-midnight bounds depend on the machine's time zone; the golden records it.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const tree = resolve(arg('tree', 'C:/Project/mixdog'));
const corpus = resolve(arg('corpus', 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus'));
const repo = resolve(import.meta.dirname, '../../..');
const outDir = join(repo, 'native/core/fixtures/ledger-queries');
const treeUrl = pathToFileURL(tree).href;
const llm = (file) => `${treeUrl}/src/runtime/shared/llm/${file}`;
const ledgerMod = await import(llm('usage-ledger.mjs'));
const rollupMod = await import(llm('usage-ledger-rollup.mjs'));
const periodMod = await import(`${treeUrl}/src/session-runtime/services/usage-stats-period.mjs`);
const modelMod = await import(`${treeUrl}/src/session-runtime/services/usage-stats-model.mjs`);

const work0 = mkdtempSync(join(tmpdir(), 'ledger-stats-shim-'));
// today's usage-stats-api.mjs with absolute imports and the two write-side imports stubbed
let shim = readFileSync(join(tree, 'src/session-runtime/usage-stats-api.mjs'), 'utf8');
shim = shim.replace(/import \{ refreshUnpricedUsageAsync \} from '[^']+';/, 'const refreshUnpricedUsageAsync = async () => {};');
shim = shim.replace(/import \{ importUsageHistory \} from '[^']+';/, 'const importUsageHistory = async () => {};');
shim = shim.replace(/(from |import\()'\.\.\//g, `$1'${treeUrl}/src/`).replace(/(from |import\()'\.\/services\//g, `$1'${treeUrl}/src/session-runtime/services/`);
const shimPath = join(work0, 'usage-stats-api.shim.mjs');
writeFileSync(shimPath, shim);
const { createUsageStatsApi } = await import(pathToFileURL(shimPath).href);

const sources = {
  v145: { file: join(repo, 'native/core/fixtures/migration/ledger-v145/ledger.sqlite') },
  corpus: { file: join(corpus, 'v145/usage/ledger.sqlite') },
  v145priced: {
    file: join(repo, 'native/core/fixtures/migration/ledger-v145/ledger.sqlite'),
    // The fixture's subscription records carry no price: give the anthropic ones a list-price
    // cost and a subscription cost source, and a quota meter that rose with it.
    prepareSql: [
      "UPDATE usage_events SET cost_usd=(input*3.0+output*15.0+cache_read*0.3+cache_write*3.75)/1000000.0 WHERE route IN (SELECT id FROM usage_routes WHERE json_extract(signature,'$[0]')='anthropic-oauth')",
      "UPDATE usage_routes SET signature=json_set(signature,'$[4]','subscription') WHERE json_extract(signature,'$[0]')='anthropic-oauth'",
    ],
    seedProvider: 'anthropic-oauth',
  },
};
mkdirSync(outDir, { recursive: true });

const DAY = 86_400_000;
const outcome = async (fn) => {
  try {
    return { result: await fn() };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
};
const LABELS = ['accountLabel', 'accountRank', 'accountInRoster', 'accountEmail'];
const unlabeled = (history) =>
  history?.subscriptions ? { ...history, subscriptions: history.subscriptions.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !LABELS.includes(k)))) } : history;

// Deterministic meter readings for one provider account over [lo, hi]: a weekly whole-percent
// window and a five-hour quarter-step window that rise with the account's recorded cost, plus
// outside use now and then.
function quotaSeeds(db, provider, account, lo, hi) {
  const events = db.prepare(`SELECT e.ts,e.cost_usd AS c FROM usage_events e JOIN usage_routes r ON r.id=e.route
      WHERE json_extract(r.signature,'$[0]')=? AND e.cost_usd IS NOT NULL ORDER BY e.ts`).all(provider);
  const total = events.reduce((sum, e) => sum + e.c, 0);
  let seed = 20260101;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const seeds = [];
  const track = (label, span, perPoint, step) => {
    let outside = 0;
    for (let ts = lo; ts <= hi + 3_600_000; ts += 25 * 60_000) {
      const start = lo + Math.floor((ts - lo) / span) * span;
      if (next() < 0.07) outside += 0.4 + next() * 2;
      if (ts === start) outside = 0;
      const spent = events.filter((e) => e.ts >= start && e.ts <= ts).reduce((sum, e) => sum + e.c, 0);
      const raw = Math.min(100, spent / perPoint + outside);
      seeds.push({ provider, account, label, ts, usedPct: Math.round(raw / step) * step, resetAt: start + span });
    }
  };
  track('7D', 7 * DAY, total / 30, 1);
  track('5H', 5 * 3_600_000, total / 200, 0.25);
  return seeds;
}

for (const [name, source] of Object.entries(sources)) {
  const work = mkdtempSync(join(tmpdir(), `ledger-stats-${name}-`));
  const path = join(work, 'ledger.sqlite');
  copyFileSync(source.file, path);
  if (source.prepareSql) {
    const raw = new DatabaseSync(path);
    for (const sql of source.prepareSql) raw.exec(sql);
    raw.close();
  }
  process.env.MIXDOG_DATA_DIR = work;
  const ledger = new ledgerMod.UsageLedger(path);
  const db = ledger.db;
  db.exec('DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0 WHERE id=1');
  while (!rollupMod.buildSessionDaysStep(db, 200)) { /* resumable build, same budget as the Rust test */ }

  const bounds = db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM usage_events').get();
  let seeds = [];
  if (source.seedProvider) {
    seeds = quotaSeeds(db, source.seedProvider, 'acct-a', bounds.lo, bounds.hi);
    ledger.recordQuota(seeds);
  }
  const quotaHi = db.prepare('SELECT MAX(seen_until) AS m FROM quota_samples').get().m ?? 0;
  const now = Math.max(bounds.hi, quotaHi) + 5 * 3_600_000;
  Date.now = () => now;

  const series = ledgerMod.UsageLedger ? [] : [];
  const quotaList = db.prepare('SELECT provider,account,label FROM quota_samples GROUP BY provider,account,label').all();
  const inUseOf = {};
  for (const row of quotaList) inUseOf[row.provider] ??= row.account;
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    accountPool: (provider) => ({ accounts: [], selectedId: inUseOf[provider] ?? '' }),
    accountEmails: () => ({}),
    getSessionId: () => null,
    sessionMetadata: async () => null,
  });
  // async ledger calls go through the ledger worker, which opens the same file read-only
  const days = db.prepare('SELECT DISTINCT day FROM daily ORDER BY day').all().map((r) => r.day);
  const lastDay = days.at(-1);
  const midDay = days[Math.floor(days.length / 2)];
  const firstDay = days[0];

  const periodRequests = [
    {}, { view: 'hour' }, { view: '7d' }, { view: '7d', anchor: midDay }, { view: 'day' }, { view: 'week', anchor: lastDay },
    { view: 'month' }, { view: 'year' }, { view: 'all' },
    { view: 'custom', startDay: firstDay, endDay: lastDay },
    { view: 'custom', startDay: midDay, endDay: lastDay, startTime: '09:30', endTime: '18:00' },
    { view: 'custom', startDay: lastDay, endDay: lastDay, startTime: '01:15:30', endTime: '02:45:10' },
    { view: 'custom', startDay: lastDay, endDay: lastDay },
    { view: 'bogus' }, { view: '7d', anchor: 'tomorrow' }, { view: '7d', anchor: '2026-02-30' }, { view: '7d', anchor: '1969-12-31' },
    { view: 'custom', startDay: lastDay }, { view: 'custom', startDay: lastDay, endDay: midDay },
    { view: 'custom', startDay: midDay, endDay: '2999-01-01' },
    { view: 'custom', startDay: midDay, endDay: lastDay, startTime: '25:00' },
    { view: 'custom', startDay: midDay, endDay: lastDay, endTime: '9:00' },
  ];
  const periods = [];
  for (const request of periodRequests) {
    periods.push({ request, ...(await outcome(() => periodMod.resolveUsageStatsPeriod({ ...request, now }))) });
  }

  const statOptions = [
    {}, { days: 0 }, { days: 1 }, { days: 7 }, { days: 30, source: 'conversation', modelLimit: 3 }, { days: 'all' }, { days: '14' },
    { days: -3 }, { days: 99999 }, { modelLimit: 1 }, { source: 'conversation' },
    { view: 'hour' }, { view: 'hour', source: 'conversation' }, { view: '7d' }, { view: 'day', source: 'conversation' },
    { view: 'week', modelLimit: 2 }, { view: 'month' }, { view: 'all' }, { view: 'year', source: 'conversation' },
    { view: '7d', anchor: midDay },
    { view: 'custom', startDay: firstDay, endDay: lastDay },
    { view: 'custom', startDay: midDay, endDay: lastDay, startTime: '09:30', endTime: '18:00' },
    { view: 'custom', startDay: lastDay, endDay: lastDay, startTime: '01:15', endTime: '23:00', source: 'conversation' },
    { view: 'nope' },
  ];
  const stats = [];
  for (const options of statOptions) stats.push({ options, ...(await outcome(() => api.getUsageStats(options))) });

  const requestOptions = [
    {}, { view: 'day', limit: 20 }, { view: 'all', limit: 5 }, { view: 'all', status: 'failed', limit: 10 }, { view: '7d', asOf: now - 3_600_000 },
    { view: 'all', asOf: now + 99_000_000_000 }, { view: 'week', model: db.prepare("SELECT json_extract(signature,'$[1]') AS m FROM usage_routes ORDER BY id LIMIT 1").get()?.m },
  ];
  const requests = [];
  for (const options of requestOptions) {
    const o = await outcome(() => api.getUsageRequests(options));
    if (o.result) {
      const { requests: list, ...envelope } = o.result;
      requests.push({ options, result: { ...envelope, requestCount: list.length } });
    } else requests.push({ options, ...o });
  }

  const quotaCases = [{}];
  const windowsPage = (options) => outcome(() => api.getQuotaHistory({ ...options, page: 0 }));
  for (const row of quotaList) {
    const selection = { provider: row.provider, account: row.account, window: row.label };
    quotaCases.push(selection);
    const firstPage = (await windowsPage(selection)).result;
    const keys = firstPage?.windows?.map((w) => w.key) ?? [];
    if (keys.length > 1) quotaCases.push({ ...selection, anchor: keys[1] });
    if (keys.length) quotaCases.push({ ...selection, anchor: keys.at(-1) });
    quotaCases.push({ ...selection, page: 0 }, { ...selection, page: 1 }, { ...selection, page: 9999 });
  }
  quotaCases.push({ view: 'day' }, { view: 'hour' }, { view: 'all' }, { view: '7d', anchor: midDay },
    { view: 'custom', startDay: firstDay, endDay: lastDay }, { view: 'custom', startDay: lastDay, endDay: lastDay, startTime: '00:30', endTime: '12:00' },
    { provider: 'no-such' }, { page: 0, provider: 'no-such' }, { window: '5h' });
  const quotaHistory = [];
  for (const options of quotaCases) {
    const o = await outcome(() => api.getQuotaHistory(options));
    quotaHistory.push({ options, ...(o.result ? { result: unlabeled(o.result) } : o) });
  }

  const sessionSnapshots = [
    { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnownTurns: 0, unmeasuredTurns: 0, speedOutput: 0, speedMs: 0 },
    { turns: 7, input: 1234, output: 4321, cacheRead: 99999, cacheWrite: 555, costUsd: 0.123456789, costKnownTurns: 5, unmeasuredTurns: 0, speedOutput: 4321, speedMs: 23000 },
    { turns: 3, input: 0, output: 12, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnownTurns: 0, unmeasuredTurns: 3, speedOutput: 0, speedMs: 0 },
  ].map((usage) => ({ usage, result: modelMod.sessionUsageSnapshot(usage) }));

  const golden = {
    ledger: name,
    source: source.file.replace(repo, '<repo>').replace(corpus, '<corpus>'),
    timezoneOffsetMinutes: new Date(bounds.hi).getTimezoneOffset(),
    now,
    prepareSql: source.prepareSql ?? [],
    quotaSeeds: seeds,
    inUse: inUseOf,
    periods, stats, requests, quotaHistory, sessionSnapshots,
  };
  void series;
  writeFileSync(join(outDir, `stats-${name}.json`), `${JSON.stringify(golden)}\n`);
  ledger.close();
  ledgerMod.closeUsageLedgers?.();
  rmSync(work, { recursive: true, force: true });
  console.log(name, { periods: periods.length, stats: stats.length, requests: requests.length, quotaHistory: quotaHistory.length, errors: [...periods, ...stats, ...requests, ...quotaHistory].filter((c) => c.error).length });
}
rmSync(work0, { recursive: true, force: true });
process.exit(0);
