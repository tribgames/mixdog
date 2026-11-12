#!/usr/bin/env node
// Golden twin of Node's per-turn change-record file (`runtime/shared/turn-snapshot-store.mjs`): what the
// store writes to `changes/<hash>.jsonl` for a run of upserts and updates (the whole file after each
// step, and the records a read answers), and what it does with a previous-format `changes/<hash>.json`
// (read as it is, migrated by the first write). The Rust core replays the same ops
// (`mixdog-core-review`, `turn_review::store_tests`) and must write the same lines and read the same
// records, so either side can take over the other's data directory.
//
//   node benchmarks/rust-core/recorders/record-turn-change-store.mjs [--tree C:/Project/mixdog] [--work <dir>]
//
// The recording runs the real module with `Date.now` replaced by a counter: timestamps are the one
// thing the replay normalises (a core stamps real time).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeSetManifest, writeText } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-change-store-')));
const store = await importFrom(tree, 'src/runtime/shared/turn-snapshot-store.mjs');

let clock = 1_700_000_000_000;
Date.now = () => (clock += 1);

const hashOf = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
const file = (path, extra = {}) => ({ path, status: 'M', additions: 1, deletions: 1, revertable: true, patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`, ...extra });
const next = (checkpointId, files, extra = {}) => ({ checkpointId, kind: 'git', root: '/work/repo', agents: [], counts: 'own', files, ...extra });

function dataDir(name) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  store._setTurnSnapshotStoreRootForTest(dir);
  return dir;
}
const changesFile = (dir, sessionId, ext) => join(dir, 'changes', `${hashOf(sessionId)}.${ext}`);
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

async function step(dir, sessionId, op) {
  if (op.op === 'upsert') await store.upsertTurnChangeRecord(sessionId, op.next);
  else if (op.op === 'update') {
    await store.updateTurnChangeRecord(sessionId, op.checkpointId, (prior) =>
      prior.files.map((f) => (f.path === op.path ? { ...f, state: op.state } : f)));
  } else throw new Error(`unknown op ${op.op}`);
  return {
    op,
    jsonl: readOrNull(changesFile(dir, sessionId, 'jsonl')),
    json: readOrNull(changesFile(dir, sessionId, 'json')),
    records: await store.loadTurnChangeRecords(sessionId),
    count: await store.countTurnChangeRecords(sessionId),
  };
}

const scenarios = [];

// A run of writes on a fresh session: the first writes whole, each later one appends a line; a re-upsert of
// a checkpoint replaces its record; an upsert that changes nothing writes nothing; an update bumps the revision.
{
  const sessionId = 'session-append';
  const dir = dataDir('append');
  const ops = [
    { op: 'upsert', next: next('cp-1', [file('a.txt'), file('b.txt')]) },
    { op: 'upsert', next: next('cp-2', [file('c.txt')], { outside: [file('/elsewhere/x.txt')] }) },
    { op: 'upsert', next: next('cp-1', [file('a.txt', { additions: 5 })]) },
    { op: 'upsert', next: next('cp-2', [file('c.txt')], { outside: [file('/elsewhere/x.txt')] }) },
    { op: 'update', checkpointId: 'cp-2', path: 'c.txt', state: 'reverted' },
    { op: 'upsert', next: next('cp-2', [file('d.txt')]) },
  ];
  const steps = [];
  for (const op of ops) steps.push(await step(dir, sessionId, op));
  scenarios.push({ name: 'append', sessionId, hash: hashOf(sessionId), steps });
}

// The previous format's file, as an older Node wrote it: read as it is; the first write migrates it.
{
  const sessionId = 'session-legacy';
  const dir = dataDir('legacy');
  mkdirSync(join(dir, 'changes'), { recursive: true });
  const legacy = {
    version: 1,
    sessionId,
    records: [
      { checkpointId: 'old-1', kind: 'git', root: '/work/repo', agents: [], files: [{ ...file('a.txt'), state: 'applied' }], revision: 1, createdAt: 10, updatedAt: 10 },
      { checkpointId: 'old-2', kind: 'git', root: '/work/repo', agents: [], files: [{ ...file('b.txt'), state: 'reverted' }], revision: 2, createdAt: 20, updatedAt: 30 },
    ],
  };
  const legacyText = JSON.stringify(legacy);
  writeFileSync(changesFile(dir, sessionId, 'json'), legacyText);
  const before = { json: legacyText, records: await store.loadTurnChangeRecords(sessionId), count: await store.countTurnChangeRecords(sessionId) };
  const steps = [await step(dir, sessionId, { op: 'upsert', next: next('new-1', [file('c.txt')]) }), await step(dir, sessionId, { op: 'update', checkpointId: 'old-2', path: 'b.txt', state: 'applied' })];
  scenarios.push({ name: 'legacy', sessionId, hash: hashOf(sessionId), before, steps });
}

const out = join(FIXTURES_ROOT, 'turn-change-store');
const stage = stageSet(out);
writeText(join(stage, 'scenarios.json'), `${JSON.stringify(scenarios, null, 1)}\n`);
writeSetManifest(stage, {
  set: 'turn-change-store',
  recorder: 'benchmarks/rust-core/recorders/record-turn-change-store.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-change-store.mjs --tree <product tree with node_modules>',
  identityTree: tree,
  extra: {
    ...recorderProvenance(import.meta.url),
    normalised: { reason: 'Date.now is a counter in the recording; a core stamps real time', fields: ['createdAt', 'updatedAt'] },
  },
});
commitStage(stage, out);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}`);
