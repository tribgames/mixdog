#!/usr/bin/env node
// Genuine 1.4.5 catalog rows: Node's own `_sessionSummary` (store-summary-index.mjs) over every
// session json of the migration corpus. The Rust `summary::catalog_row` (mixdog-store) must
// produce the same row for the same header and messages, live and after reprojection.
//
//   node benchmarks/rust-core/recorders/record-session-summary.mjs --tree <tree w/ node_modules> \
//        [--corpus <migration-corpus>]
// Output: native/core/fixtures/migration/session-summary/summaries.json
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const corpus = resolve(args.get('corpus') ?? 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus');
const { _sessionSummary } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-index.mjs');

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'electron-profile') walk(path);
    } else if (/\.json$/.test(entry.name) && path.split(sep).includes('sessions')) files.push(path);
  }
};
walk(corpus);

const sessions = [];
const skipped = [];
for (const file of files.sort()) {
  const key = relative(corpus, file).split(sep).join('/');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  if (!session.id || !Array.isArray(session.messages)) {
    skipped.push({ key, reason: 'no id or messages' });
  } else if (!(session.updatedAt > 0)) {
    // Without updatedAt the row carries Date.now(), which no recording can pin.
    skipped.push({ key, reason: 'no updatedAt' });
  } else {
    sessions.push({ key, summary: _sessionSummary(session) });
  }
}

const finalOut = join(FIXTURES_ROOT, 'migration', 'session-summary');
const out = stageSet(finalOut);
writeJson(join(out, 'summaries.json'), { note: '_sessionSummary(JSON.parse(file)) per corpus session json; key = path under the corpus', sessions, skipped });
writeSetManifest(out, {
  set: 'migration/session-summary',
  recorder: 'benchmarks/rust-core/recorders/record-session-summary.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-summary.mjs --tree <tree> [--corpus <migration-corpus>]',
  extra: { sessions: sessions.length, skipped: skipped.length },
});
commitStage(out, finalOut);
console.log(`sessions=${sessions.length} skipped=${skipped.length}`);
