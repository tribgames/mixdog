#!/usr/bin/env node
// The core-memory key at start-up, as Node's memory database opening leaves it: `openDatabase(dataDir, 384, identity)` of
// src/runtime/memory/lib/memory.mjs over a throwaway profile (its own PostgreSQL), whose `ensureCurrentSchemaExtensions` runs
// `ensureCoreKeyIndex` (core-memory-uniqueness.mjs:8) on every opening. Each step runs its `sql` on the opened database,
// closes it (`closeDatabase`) and opens it again; recorded after each opening: the whole index and constraint listing of
// core_entries, its rows, and the `[core-memory]` lines the opening wrote. Steps:
//   1. a fresh profile;
//   2. a store an old build left: two rows with one common key, the legacy (project_id, element) key without the pool key;
//   3. the conflict resolved by an explicit edit, the legacy key back in its old form; then an agent memory sharing the key;
//   4. the race: a duplicate committed between the opening's conflict check and its index build (the 23505 path).
// The race's one seam: the opened database's `query`, which, once, after the conflict check answered, commits `raceSql` on
// another connection before the check's answer returns. Nothing waits on time.
//
//   node benchmarks/rust-core/recorders/record-memory-core-key.mjs --tree <dir>
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

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
const IDENTITY = { model: 'test', dtype: 'q8' };

const INSERT = (element, summary, agent) =>
  `INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ('${element}', '${summary}', 'rule', NULL, ${agent ? `'${agent}'` : 'NULL'}, 0, 0)`;
const LISTING = `SELECT 'index' AS kind, indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'memory' AND tablename = 'core_entries'
  UNION ALL SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'memory.core_entries'::regclass
  ORDER BY 1, 2`;
const ROWS = 'SELECT id::int AS id, project_id, agent_id, element, summary, category, status FROM core_entries ORDER BY id';

let db = await openDatabase(dataDir, 384, IDENTITY);
const state = async () => ({ listing: (await db.query(LISTING)).rows, rows: (await db.query(ROWS)).rows });

const steps = [{ label: 'a fresh profile', logs: logged.splice(0), ...(await state()) }];
const step = async (label, sql, { raceSql, after } = {}) => {
  if (sql) await db.exec(sql);
  await closeDatabase(dataDir);
  if (raceSql) {
    // The opening's db is the adapter's cached instance for this profile.
    const { db: raw } = await pgAdapter.ensurePgInstance(dataDir, { schema: 'memory' });
    const query = raw.query;
    let armed = true;
    raw.query = async (text, params) => {
      const out = await query(text, params);
      if (armed && /HAVING COUNT\(\*\) > 1/.test(text)) {
        armed = false;
        await query(raceSql);
      }
      return out;
    };
  }
  const opened = await capture(async () => {
    db = await openDatabase(dataDir, 384, IDENTITY);
    return 'opened';
  });
  const afterOut = after ? await capture(async () => (await db.query(after)).rowCount) : undefined;
  steps.push({ label, sql, raceSql, after, opened, afterOut, logs: logged.splice(0), ...(await state()) });
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
await step('a duplicate committed between the conflict check and the index build', 'DROP INDEX core_entries_unique_pool_elem', {
  raceSql: INSERT('key', 'Racing duplicate'),
});

finish(ctx, {
  url: import.meta.url,
  set: 'memory-core-key',
  golden: { identity: IDENTITY, dims: 384, steps },
  extra: {
    entry: 'src/runtime/memory/lib/memory.mjs openDatabase(dataDir, 384, identity) and closeDatabase(dataDir)',
    replay: 'native/core/crates/mixdog-services/src/memory/tests/core_key.rs',
    exclusions: "the race of step 4 is made at one seam, the opened database's query: after the conflict check answers, raceSql is committed on another connection",
    normalised: 'none',
  },
});
await closeDatabase(dataDir);
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
