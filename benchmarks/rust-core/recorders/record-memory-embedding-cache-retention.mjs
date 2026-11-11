#!/usr/bin/env node
// Node's embedding cache retention (src/runtime/memory/lib/embedding-cache-retention.test.mjs, 3 cases) from the real
// `resolveEmbeddingCacheMaxRows` and `pruneEmbeddingCache`. The database is the service boundary: a scripted `db.query`
// that answers the count and the DELETE row count, and records every statement (text and params) in order. Further
// shapes: no overflow, exactly at the cap, exactly twice the cap (delete, not truncate), batching over several
// DELETEs, a DELETE that removes nothing, a failing query.
//
//   node benchmarks/rust-core/recorders/record-memory-embedding-cache-retention.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { pruneEmbeddingCache, resolveEmbeddingCacheMaxRows, DEFAULT_EMBED_CACHE_MAX_ROWS } = await importFrom(ctx.tree, 'src/runtime/memory/lib/embedding-cache-retention.mjs');

const resolve = [];
for (const value of [undefined, '25000', '0', 'invalid', '-5', '12.9', '', null, '1e3', ' 7 ', 'Infinity', '0.5']) {
  resolve.push({ value: value === undefined ? { absent: true } : value, ...(await capture(() => resolveEmbeddingCacheMaxRows(value))) });
}
const envBefore = process.env.MIXDOG_EMBED_CACHE_MAX_ROWS;
delete process.env.MIXDOG_EMBED_CACHE_MAX_ROWS;
const fromEnv = [await capture(() => resolveEmbeddingCacheMaxRows())];
process.env.MIXDOG_EMBED_CACHE_MAX_ROWS = '321';
fromEnv.push(await capture(() => resolveEmbeddingCacheMaxRows()));
if (envBefore === undefined) delete process.env.MIXDOG_EMBED_CACHE_MAX_ROWS;
else process.env.MIXDOG_EMBED_CACHE_MAX_ROWS = envBefore;

// `count`: what the count query answers; `deleted`: rowCount each DELETE answers (number, or 'requested' = its $1).
async function prune(count, options, deleted = 'requested', failOn = null) {
  const statements = [];
  const db = {
    query: async (sql, params) => {
      statements.push({ sql, params: params ?? null });
      if (failOn && sql.includes(failOn)) throw Object.assign(new Error(`scripted failure on ${failOn}`), { code: 'XX000' });
      if (sql.includes('count(*)')) return { rows: [{ n: String(count) }] };
      if (sql.startsWith('TRUNCATE')) return { rowCount: null, rows: [] };
      return { rowCount: deleted === 'requested' ? params[0] : deleted, rows: [] };
    },
  };
  return { count, options, deleteAnswers: deleted, failOn, ...(await capture(() => pruneEmbeddingCache(db, options))), statements };
}

const prunes = [
  await prune(32495, { maxRows: 10_000 }),
  await prune(10007, { maxRows: 10_000 }),
  await prune(0, { maxRows: 10_000 }),
  await prune(10_000, { maxRows: 10_000 }),
  await prune(9_999, { maxRows: 10_000 }),
  await prune(20_000, { maxRows: 10_000 }),
  await prune(20_001, { maxRows: 10_000 }),
  await prune(12_000, { maxRows: 10_000, batchSize: 500 }),
  await prune(10_300, { maxRows: 10_000, batchSize: 100 }),
  await prune(10_300, { maxRows: 10_000, batchSize: 100 }, 40),
  await prune(10_300, { maxRows: 10_000 }, 0),
  await prune(10_300, { maxRows: 10_000 }, 'requested', 'DELETE'),
  await prune(32_495, { maxRows: 10_000 }, 'requested', 'TRUNCATE'),
  await prune(10_007, {}),
];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-embedding-cache-retention',
  golden: {
    domain: 'memory-embedding-cache-retention',
    source: 'src/runtime/memory/lib/embedding-cache-retention.test.mjs',
    cases: [
      { name: 'embedding cache defaults to ten thousand rows with a positive override', defaultMaxRows: DEFAULT_EMBED_CACHE_MAX_ROWS, resolve, fromEnv },
      { name: 'a legacy oversized embedding cache is truncated to reclaim disk pages', prune: prunes[0] },
      { name: 'small overflow deletes only the oldest excess rows', prune: prunes[1] },
      { name: 'further shapes (beyond the test file)', prunes: prunes.slice(2) },
    ],
  },
  extra: {
    entry: { runs: 'resolveEmbeddingCacheMaxRows and pruneEmbeddingCache (embedding-cache-retention.mjs)', notRun: 'a real database: db.query is a scripted endpoint that records statements; the last prune call (no options) uses the default cap from the environment' },
    replay: 'public entry: RawEmbedFlush::flush (mixdog-services memory/ingest/embed_flush.rs:114; reached by memory ingest flush_after_ingest, ingest/mod.rs:227, and by the cycles flush_raw), which ends in prune (embed_flush.rs:341,346) with cache_max_rows (embed_flush.rs:80, reading MIXDOG_EMBED_CACHE_MAX_ROWS). A replay runs a flush over a database seam whose cache table holds `count` rows (and whose DELETE answers `deleteAnswers`) with the cap set by the env value; compares the ordered statements (text and params) exactly and the error text. prune and cache_max_rows are private: the recorded `options.maxRows` and `batchSize` reach them only as the env cap and the Rust batch constant, so the `resolve` list is replayed through the env variable and the prunes through flush; a `batchSize` option has no Rust public input (listed as work for the Rust side if parity is wanted). NODE BUG recorded as is: resolveEmbeddingCacheMaxRows(\'0.5\') returns 0 (a positive fraction floors to 0, which wipes the cache); fix proposed in D:\\mixdog-build\\tmp\\node-patches\\node-fix-embedding-cache-max-rows.patch',
    exclusions: 'none',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
