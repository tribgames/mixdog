#!/usr/bin/env node
// The core-memory key at start-up, as Node's memory database opening leaves it: `openDatabase(dataDir, 384, identity)` of
// src/runtime/memory/lib/memory.mjs over a throwaway profile (its own PostgreSQL), whose `ensureCurrentSchemaExtensions` runs
// `ensureCoreKeyIndex` (core-memory-uniqueness.mjs:8) on every opening. Each step runs its `sql` on the opened database,
// closes it (`closeDatabase`) and opens it again; recorded after each opening: the whole index and constraint listing of
// core_entries, its rows, and the `[core-memory]` lines the opening wrote. Steps:
//   1. a fresh profile;
//   2. a store an old build left: two rows with one common key, the legacy (project_id, element) key without the pool key;
//   3. the conflict resolved by an explicit edit, the legacy key back in its old form; then an agent memory sharing the key;
//   4. the race: two starters (two processes, as a daemon handoff has them) open the same store at once, the pool key
//      missing; each is held by an explicit gate just before its key build (`CREATE UNIQUE INDEX ... pool_elem`) and both
//      are released together once both arrived (the 23505 path: one builds the key, the other's build collides).
// The race's one seam, in each starter: the opened database's `exec`, which holds the key build until the recorder's
// release. Nothing waits on time; every wait has a deadline.
//
//   node benchmarks/rust-core/recorders/record-memory-core-key.mjs --tree <dir>
import { fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { begin, capture, finish, importFrom, within } from './lib/mc-record.mjs';

const IDENTITY = { model: 'test', dtype: 'q8' };
const KEY_BUILD = /CREATE UNIQUE INDEX IF NOT EXISTS core_entries_unique_pool_elem/;

// A starter: this file run again by the recorder (MIXDOG_CORE_KEY_STARTER), opening the store the recorder's cluster serves.
if (process.env.MIXDOG_CORE_KEY_STARTER) {
  delete process.env.MIXDOG_QUIET_MEMORY_LOG;
  const logs = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (text.startsWith('[core-memory]')) logs.push(text.replace(/\n$/, ''));
    return write(chunk, ...rest);
  };
  const tree = process.env.MIXDOG_CORE_KEY_TREE;
  const dataDir = process.env.MIXDOG_DATA_DIR;
  const { openDatabase, closeDatabase } = await importFrom(tree, 'src/runtime/memory/lib/memory.mjs');
  const pgAdapter = await importFrom(tree, 'src/runtime/memory/lib/pg/adapter.mjs');
  const { db: raw } = await pgAdapter.ensurePgInstance(dataDir, { schema: 'memory' });
  const exec = raw.exec;
  const released = new Promise((resolve) => process.on('message', (msg) => msg === 'release' && resolve()));
  raw.exec = async (text, ...rest) => {
    if (KEY_BUILD.test(text)) {
      process.send('arrived');
      await released;
    }
    return exec.call(raw, text, ...rest);
  };
  const opened = await capture(async () => {
    await openDatabase(dataDir, 384, IDENTITY);
    return 'opened';
  });
  await closeDatabase(dataDir);
  process.send({ opened, logs }, () => process.exit(0));
} else {

const ctx = begin();
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const dataDir = mkdtempSync(join(SCRATCH, 'corekey-')).replaceAll('\\', '/');
Object.assign(process.env, { MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: dataDir });
// A host that mutes the memory log (a session runtime sets it) would hide the lines this recording keeps.
delete process.env.MIXDOG_QUIET_MEMORY_LOG;

// The memory log writes through the stderr `write` it captured at import: patched before the import.
const logged = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  if (text.startsWith('[core-memory]')) logged.push(text.replace(/\n$/, ''));
  return realWrite(chunk, ...rest);
};

const { openDatabase, closeDatabase } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory.mjs');
const pgAdapter = await importFrom(ctx.tree, 'src/runtime/memory/lib/pg/adapter.mjs');

const INSERT = (element, summary, agent) =>
  `INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ('${element}', '${summary}', 'rule', NULL, ${agent ? `'${agent}'` : 'NULL'}, 0, 0)`;
const LISTING = `SELECT 'index' AS kind, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'memory' AND tablename = 'core_entries'
  UNION ALL SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'memory.core_entries'::regclass
  ORDER BY 1, 2`;
const ROWS = 'SELECT id::int AS id, project_id, agent_id, element, summary, category, status FROM core_entries ORDER BY id';

let db = await openDatabase(dataDir, 384, IDENTITY);
const state = async () => ({ listing: (await db.query(LISTING)).rows, rows: (await db.query(ROWS)).rows });

const steps = [{ label: 'a fresh profile', logs: logged.splice(0), ...(await state()) }];
const step = async (label, sql, { after } = {}) => {
  if (sql) await db.exec(sql);
  await closeDatabase(dataDir);
  const opened = await capture(async () => {
    db = await openDatabase(dataDir, 384, IDENTITY);
    return 'opened';
  });
  const afterOut = after ? await capture(async () => (await db.query(after)).rowCount) : undefined;
  steps.push({ label, sql, after, opened, afterOut, logs: logged.splice(0), ...(await state()) });
};

// Two starters at once over the store this process's cluster serves, released together once both reached the key build.
const race = async (label, sql) => {
  await db.exec(sql);
  await closeDatabase(dataDir);
  const starters = [0, 1].map(() =>
    fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, MIXDOG_CORE_KEY_STARTER: '1', MIXDOG_CORE_KEY_TREE: ctx.tree, MIXDOG_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  );
  const message = (child, what) => new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`a starter exited (${code}) before ${what}`)));
  });
  await within(`${label}: both starters at the key build`, Promise.all(starters.map((child) => message(child, 'the key build'))));
  const outcomes = starters.map((child) => message(child, 'its outcome'));
  for (const child of starters) child.send('release');
  const ended = await within(`${label}: both openings ended`, Promise.all(outcomes));
  db = await openDatabase(dataDir, 384, IDENTITY);
  // Which starter wins the build is not fixed: the outcomes are listed in sorted order.
  const sorted = ended.map((o) => JSON.stringify(o)).sort().map((o) => JSON.parse(o));
  steps.push({ label, sql, starters: sorted, ...(await state()) });
};

await step(
  'a store an old build left: duplicate common keys under the legacy key',
  [
    'DROP INDEX core_entries_unique_pool_elem',
    INSERT('key', 'First approved preference'),
    INSERT('key', 'Second approved preference'),
    'CREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, (element || id::text))',
  ].join(';\n')
);
await step(
  'the conflict resolved: the pool key replaces the legacy key, and an agent memory may share the common key',
  [
    "UPDATE core_entries SET element = 'resolved' WHERE id = 2",
    'DROP INDEX core_entries_unique_proj_elem',
    'CREATE UNIQUE INDEX core_entries_unique_proj_elem ON core_entries (project_id, element)',
  ].join(';\n'),
  { after: INSERT('key', 'An agent may share the key', 'reviewer') }
);
await race('two starters build the missing key at once', 'DROP INDEX core_entries_unique_pool_elem');

finish(ctx, {
  url: import.meta.url,
  set: 'memory-core-key',
  golden: { identity: IDENTITY, dims: 384, steps },
  extra: {
    entry: 'src/runtime/memory/lib/memory.mjs openDatabase(dataDir, 384, identity) and closeDatabase(dataDir)',
    replay: 'native/core/crates/mixdog-services/src/memory/tests/core_key.rs',
    exclusions: "the race of step 4 is held at one seam in each starter, the opened database's exec: the key build waits for the recorder's release, given once both starters reached it. A starter's own log lines other than [core-memory] are not recorded",
    normalised: 'step 4: the two starters\' outcomes ({opened, logs}) are listed in sorted order (which one wins the build is not fixed)',
  },
});
await closeDatabase(dataDir);
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
}
