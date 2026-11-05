#!/usr/bin/env node
// Genuine 1.4.5 usage ledger: the tag's own `usage-ledger.mjs` (git archive of
// v1.4.5 / 69fe41b05, read-only snapshot) records the usage rows of the 1.4.5
// migration corpus (`gateway-usage.local.jsonl`) into a fresh SQLite ledger in a
// temp data dir. The scratch corpus' own usage/ledger.sqlite was written by the
// dev build (18 tables) and is NOT 1.4.5-shaped.
//
//   node benchmarks/rust-core/recorders/record-ledger-v145.mjs --tree <tree w/ node_modules> \
//        [--corpus <migration-corpus>] [--tag-tree <git archive 69fe41b05 + node_modules>]
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, stageSet, REPO_ROOT, parseArgs, resolveTree, sha256, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const corpus = resolve(args.get('corpus') ?? 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus');
const source = join(corpus, 'v145', 'gateway-usage.local.jsonl');
const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const tagCommit = git('rev-parse', '69fe41b05^{commit}');
if (git('rev-parse', 'v1.4.5^{commit}') !== tagCommit) throw new Error('v1.4.5 does not point at 69fe41b05');

const work = mkdtempSync(join(tmpdir(), 'mixdog-ledger-v145-'));
let tagTree = args.get('tag-tree') ? resolve(args.get('tag-tree')) : null;
if (!tagTree) {
  tagTree = join(work, 'tag');
  mkdirSync(tagTree);
  git('archive', '--format=tar', '-o', join(work, 'tag.tar'), '69fe41b05');
  execFileSync('tar', ['-xf', join(work, 'tag.tar'), '-C', tagTree]);
  symlinkSync(join(tree, 'node_modules'), join(tagTree, 'node_modules'), 'junction');
}
const dataDir = join(work, 'data');
mkdirSync(join(dataDir, 'usage'), { recursive: true });
const ledgerPath = join(dataDir, 'usage', 'ledger.sqlite');
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_USAGE_LEDGER_PATH = ledgerPath;

const mod = await import(pathToFileURL(join(tagTree, 'src/runtime/shared/llm/usage-ledger.mjs')).href);
const ledger = new mod.UsageLedger(ledgerPath);

// Rows in file order; the id is derived from the source line so reruns match.
const rows = [];
let lineNo = 0;
for await (const line of createInterface({ input: createReadStream(source, 'utf8') })) {
  if (!line.trim()) continue;
  lineNo += 1;
  const r = JSON.parse(line);
  rows.push(
    mod.makeUsageRecord({
      ts: r.ts, provider: r.provider, model: r.model, kind: r.providerKind, sessionId: r.sessionId, sourceType: r.sourceType,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
      costUsd: r.costUsd, durationMs: r.durationMs, serviceTier: r.serviceTier, responseId: r.responseId ?? '', origin: 'live',
      id: createHash('sha256').update(`gateway-usage.local.jsonl:${lineNo}`).digest('hex'),
    })
  );
}
for (let i = 0; i < rows.length; i += 500) ledger.record(rows.slice(i, i + 500));
await ledger.settleWrites?.();
ledger.close();
mod.closeUsageLedgers?.();

// ---- describe the result ----------------------------------------------------------
const db = new DatabaseSync(ledgerPath, { readOnly: true });
const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
const byType = (t) => objects.filter((o) => o.type === t);
const tables = byType('table');
const tableInfo = {};
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all();
  const withoutRowid = /WITHOUT ROWID/i.test(t.sql ?? '');
  const order = withoutRowid ? cols.map((c) => `"${c.name}"`).join(',') : 'rowid';
  let count = 0;
  const h = createHash('sha256');
  if (!/^CREATE VIRTUAL/i.test(t.sql ?? '')) {
    for (const row of db.prepare(`SELECT * FROM "${t.name}" ORDER BY ${order}`).iterate()) {
      count += 1;
      h.update(JSON.stringify(Object.values(row), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) + '\n');
    }
  }
  tableInfo[t.name] = { columns: cols.map((c) => c.name), rows: count, orderedRowsSha256: h.digest('hex'), orderedBy: order };
}
const meta = { userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id, journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode };
db.close();

const finalDir = join(FIXTURES_ROOT, 'migration', 'ledger-v145');
const outDir = stageSet(finalDir);
copyFileSync(ledgerPath, join(outDir, 'ledger.sqlite'));
writeJson(join(outDir, 'schema.json'), {
  counts: { tables: tables.length, indexes: byType('index').length, views: byType('view').length, triggers: byType('trigger').length },
  expectedByP0Store: { tables: 13, indexes: 7, views: 1, triggers: 16 },
  objects: objects.map((o) => ({ type: o.type, name: o.name, table: o.tbl_name, sqlSha256: sha256(o.sql ?? '') })),
  ddl: objects.map((o) => o.sql).filter(Boolean),
  pragmas: meta,
});
writeJson(join(outDir, 'tables.json'), { source: { file: 'migration-corpus/v145/gateway-usage.local.jsonl', lines: lineNo, sha256: sha256(await import('node:fs').then((fs) => fs.readFileSync(source))) }, tables: tableInfo });
writeSetManifest(outDir, {
  set: 'migration/ledger-v145',
  recorder: 'benchmarks/rust-core/recorders/record-ledger-v145.mjs',
  command: 'node benchmarks/rust-core/recorders/record-ledger-v145.mjs --tree <tree w/ node_modules> [--corpus <migration-corpus>]',
  identityTree: tagTree,
  identityRef: tagCommit,
  extra: {
    tag: 'v1.4.5', tagCommit, writer: 'src/runtime/shared/llm/usage-ledger.mjs of the tag (UsageLedger.record)',
    note: 'ledger.sqlite bytes may differ between runs (page/meta timestamps); compare schema.json and tables.json (ordered-row sha256) for reproducibility.',
    schemaCounts: { tables: tables.length, indexes: byType('index').length, views: byType('view').length, triggers: byType('trigger').length },
    rowCounts: Object.fromEntries(Object.entries(tableInfo).map(([k, v]) => [k, v.rows])),
  },
});
commitStage(outDir, finalDir);
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ rowsRecorded: rows.length, counts: { tables: tables.length, indexes: byType('index').length, views: byType('view').length, triggers: byType('trigger').length }, rowCounts: Object.fromEntries(Object.entries(tableInfo).map(([k, v]) => [k, v.rows])) }));
process.exit(0);
