#!/usr/bin/env node
// Genuine 1.4.5 `searchSessionContent` of the desktop host: requiredSessionContentQuery
// (ipc-validation.ts) then searchSessionMessages(query, { limit: 50 }) over a real session-search
// Postgres, mapped the way session-host.ts maps it. The Rust ThreadSearchService answers the same
// hits (sessionId, snippet, rank) for the same stored messages.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/benchmarks/rust-core/recorders/record-thread-search.mjs --tree <tree>
// Output: native/core/fixtures/thread-search/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const dataDir = mkdtempSync(join(tmpdir(), 'thread-search-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const search = await importFrom(tree, 'src/runtime/session-search/session-search-db.mjs');
const { requiredSessionContentQuery } = await importFrom(tree, 'apps/desktop/src/main/ipc-validation.ts');

const messages = {
  'sess-deploy': [
    { role: 'user', content: 'how do I deploy the staging server tonight' },
    { role: 'assistant', content: 'Run the deploy script, then check the staging dashboard for the deploy status.' },
  ],
  'sess-deploy-once': [{ role: 'user', content: 'deploy' }],
  'sess-docs': [
    { role: 'user', content: 'write the release notes for the docs site' },
    { role: 'assistant', content: 'Drafted release notes: fixes, docs, and a short deploy remark at the end of the page.' },
  ],
  'sess-unrelated': [{ role: 'user', content: 'what is the capital of France' }],
};
for (const [id, rows] of Object.entries(messages)) await search.appendSessionSearchMessages(id, rows, { dataDir });

const queries = [
  'deploy',
  '  deploy  ',
  'release notes',
  'dep',
  'deploy staging',
  'France',
  'nothing-matches-this',
  'DEPLOY',
  '',
  '   ',
  'x'.repeat(1024),
  'x'.repeat(1025),
];
const cases = [];
for (const query of queries) {
  let result;
  try {
    const hits = await search.searchSessionMessages(requiredSessionContentQuery(query), { limit: 50, dataDir });
    result = { ok: hits.map(({ sessionId, snippet, rank }) => ({ sessionId, snippet, rank })) };
  } catch (error) {
    result = { error: { type: error.constructor.name, message: error.message } };
  }
  cases.push({ query, result });
}
const finalOut = join(FIXTURES_ROOT, 'thread-search');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'searchSessionContent of the real 1.4.5 desktop host over these stored messages (appended in this order, one append per session)',
  messages,
  cases,
});
writeSetManifest(out, {
  set: 'thread-search',
  recorder: 'benchmarks/rust-core/recorders/record-thread-search.mjs',
  command: '(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/benchmarks/rust-core/recorders/record-thread-search.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(out, finalOut);
await search.closeSessionSearchDb?.();
rmSync(dataDir, { recursive: true, force: true });
console.log(`cases=${cases.length}`);
process.exit(0);
