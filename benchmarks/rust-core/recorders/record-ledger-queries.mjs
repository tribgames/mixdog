#!/usr/bin/env node
// Golden twin of today's Node usage queries (dashboard/stats rollup, request log, session usage)
// over two ledgers: the genuine 1.4.5 fixture and the dev-shaped corpus ledger. Each ledger is
// copied, opened by the Node UsageLedger (which upgrades the copy), its session sums are built,
// and the exported query functions of `src/runtime/shared/llm/usage-ledger*.mjs` answer a fixed
// list of queries. The queries and answers go to native/core/fixtures/ledger-queries/<name>.json;
// the Rust ledger replays the same queries against its own upgrade of the same file and must
// equal the answers exactly.
//
//   node benchmarks/rust-core/recorders/record-ledger-queries.mjs [--tree C:/Project/mixdog] [--corpus <migration-corpus>]
// The day keys and local-midnight bounds depend on the machine's time zone; the golden records it.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const llm = (file) => pathToFileURL(join(tree, 'src/runtime/shared/llm', file)).href;
const ledgerMod = await import(llm('usage-ledger.mjs'));
const rollupMod = await import(llm('usage-ledger-rollup.mjs'));
const requestsMod = await import(llm('usage-ledger-requests.mjs'));

const sources = {
  v145: join(repo, 'native/core/fixtures/migration/ledger-v145/ledger.sqlite'),
  corpus: join(corpus, 'v145/usage/ledger.sqlite'),
};
mkdirSync(outDir, { recursive: true });

for (const [name, source] of Object.entries(sources)) {
  const work = mkdtempSync(join(tmpdir(), `ledger-queries-${name}-`));
  const path = join(work, 'ledger.sqlite');
  copyFileSync(source, path);
  process.env.MIXDOG_DATA_DIR = work;
  const ledger = new ledgerMod.UsageLedger(path);
  const db = ledger.db;
  // The v3 upgrade rebuilds every session-day sum from the records, from cursor 0. A dev-shaped
  // ledger carries sums accumulated incrementally (float drift), so restart its build too.
  db.exec('DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0 WHERE id=1');
  while (!rollupMod.buildSessionDaysStep(db, 200)) { /* resumable build, same budget as the Rust test */ }

  const bounds = db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM usage_events').get();
  const days = db.prepare('SELECT DISTINCT day FROM daily ORDER BY day').all().map((r) => r.day);
  const lastDay = days.at(-1);
  const midFrom = days[Math.floor(days.length / 3)];
  const midTo = days[Math.floor((2 * days.length) / 3)];
  const sessions = db.prepare('SELECT value FROM usage_sessions ORDER BY id LIMIT 4').all().map((r) => r.value);
  const owners = db.prepare('SELECT s.value FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner LIMIT 2').all().map((r) => r.value);
  const model = db.prepare("SELECT json_extract(signature,'$[1]') AS m FROM usage_routes ORDER BY id LIMIT 1").get()?.m;

  const rollups = [
    {},
    { fromDay: midFrom, toDay: midTo },
    { hourlyDay: lastDay, fromDay: lastDay, toDay: lastDay },
    { fromMs: bounds.hi - 86_400_000, toMs: bounds.hi, hourlyDay: lastDay, fromDay: lastDay, toDay: lastDay },
    { fromMs: bounds.lo, toMs: bounds.hi },
  ];
  const requestQueries = [
    { fromMs: 0, toMs: bounds.hi, limit: 50 },
    { fromMs: 0, toMs: bounds.hi, limit: 200 },
    { fromMs: 0, toMs: bounds.hi, status: 'failed', limit: 50 },
    { fromMs: 0, toMs: bounds.hi, status: 'completed', limit: 30 },
    ...(model ? [{ fromMs: 0, toMs: bounds.hi, model, limit: 40 }] : []),
  ];
  const requests = [];
  for (const options of requestQueries) {
    const page = requestsMod.readUsageRequests(db, options);
    requests.push({ options, result: page });
    if (page.nextCursor) {
      const next = { ...options, cursor: page.nextCursor };
      requests.push({ options: next, result: requestsMod.readUsageRequests(db, next) });
    }
  }
  const sessionReads = [
    { sessionIds: sessions.slice(0, 1), ownerIds: [] },
    { sessionIds: sessions, ownerIds: [] },
    { sessionIds: sessions.slice(1, 3), ownerIds: owners },
    { sessionIds: ['no-such-session'], ownerIds: [] },
  ];
  const golden = {
    ledger: name,
    source: source.replace(repo, '<repo>').replace(corpus, '<corpus>'),
    timezoneOffsetMinutes: new Date(bounds.hi).getTimezoneOffset(),
    rollups: rollups.map((options) => ({ options, result: rollupMod.rollupUsage(db, options) })),
    requests,
    sessionUsage: sessionReads.map((q) => ({ ...q, result: rollupMod.readSessionUsage(db, q.sessionIds, q.ownerIds) })),
  };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(golden)}\n`);
  ledger.close();
  ledgerMod.closeUsageLedgers?.();
  rmSync(work, { recursive: true, force: true });
  console.log(name, { rollups: golden.rollups.length, requests: requests.length, sessionUsage: golden.sessionUsage.length });
}
process.exit(0);
