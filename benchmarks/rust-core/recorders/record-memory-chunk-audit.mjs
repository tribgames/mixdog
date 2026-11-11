#!/usr/bin/env node
// Case 81 of Node's chunk audit tests (src/runtime/memory/lib/memory-chunk-audit.test.mjs, "compact session retrieval
// includes the original root as a member without requiring includeMembers") from the real `createQueryHandlers`
// `recallSessionRows` with `compactHandoff: true`. The database is a scripted `getDb().query` (the test file's own
// fake: it answers the member query with the rows its SQL predicate selects, the root query with the verified root) and
// records every statement (text and params) in order. The other cases of the file are listed in the manifest:
// 38 (legacy audit report), 101 (non-string scope) are not recorded; 55 and 65 are covered by the cycles golden.
//
//   node benchmarks/rust-core/recorders/record-memory-chunk-audit.mjs --tree <dir>
import { begin, capture, finish, freezeClock, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_700_000_000_000;
freezeClock(CLOCK_MS); // makeChunkQuality stamps verifiedAt
const dir = 'src/runtime/memory/lib/';
const { makeChunkQuality } = await importFrom(ctx.tree, `${dir}memory-chunk-quality.mjs`);
const { createQueryHandlers } = await importFrom(ctx.tree, `${dir}query-handlers.mjs`);

const entries = () => [
  { id: 1, ts: 1000, role: 'user', session_id: 's', content: 'User requires 296 failures to be reported accurately. '.repeat(20), is_root: 1, chunk_root: 1, summary: 'There were 296 failures.' },
  { id: 2, ts: 2000, role: 'assistant', session_id: 's', content: 'Confirmed: 296 failures, not successes. '.repeat(20), is_root: 0, chunk_root: 1 },
  { id: 3, ts: 3000, role: 'user', session_id: 's', content: 'Deferred source must remain available.', is_root: 0, chunk_root: 3 },
];

async function session(label, makeRoot, options) {
  const source = entries();
  const root = makeRoot(source);
  const statements = [];
  const handlers = createQueryHandlers({
    getDb: () => ({
      query: async (sql, params) => {
        statements.push({ sql, params: params ?? null });
        if (sql.includes('WHERE chunk_root = ANY')) {
          const selected = sql.includes('AND is_root = 0') ? source.slice(1, 2) : source.slice(0, 2);
          return { rows: structuredClone(selected) };
        }
        return { rows: [structuredClone(root)] };
      },
    }),
  });
  return { label, options, root, dbEntries: source, ...(await capture(() => handlers.recallSessionRows(options))), statements };
}

const verified = (source) => ({ ...source[0], chunk_quality: makeChunkQuality(source[0].summary, source.slice(0, 2)) });
const cases = [
  await session('verified root, members read through the SQL predicate (the test)', verified, { sessionId: 's', compactHandoff: true }),
  await session('same without compactHandoff', verified, { sessionId: 's' }),
  await session('legacy root without chunk_quality', (source) => ({ ...source[0] }), { sessionId: 's', compactHandoff: true }),
  await session('altered summary on a verified root falls back to originals', (source) => ({ ...verified(source), summary: 'It succeeded.' }), { sessionId: 's', compactHandoff: true }),
];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-chunk-audit',
  golden: {
    domain: 'memory-chunk-audit',
    source: 'src/runtime/memory/lib/memory-chunk-audit.test.mjs',
    clock: { dateNowMs: CLOCK_MS, reason: 'verifiedAt of the chunk_quality the fixture roots carry' },
    cases: [{ name: 'compact session retrieval includes the original root as a member without requiring includeMembers (test line 81)', session: cases[0] }, { name: 'further shapes (beyond the test file)', sessions: cases.slice(1) }],
  },
  extra: {
    entry: { runs: 'createQueryHandlers(...).recallSessionRows (query-handlers.mjs) with makeChunkQuality (memory-chunk-quality.mjs) building the root verification', notRun: 'a real database: getDb().query is the test file\'s fake and answers by SQL text; the real PG statements are replayed by the recall goldens' },
    replay: 'mixdog-services memory: mem/recall/browse.rs session recall (recall_session_rows) + mem/recall/compact.rs compact_handoff_rows over a db seam that answers the same statements; compares the returned text/rows and the ordered statements (text and params)',
    exclusions: 'test cases 38 (legacy audit report: auditChunkEntries/collectChunkRoots are a diagnostic with no Rust counterpart), 55 and 65 (assessChunkQuality on legacy roots: covered by native/core/crates/mixdog-services mem/cycles golden_tests.rs prompts_budgets_and_quality_equal_node), 101 (non-string projectScope binding: JS typing artefact) are not recorded',
    normalised: { verifiedAt: 'Date.now() fixed at clock.dateNowMs (virtual clock, never advanced)' },
  },
});
process.exit(0);
