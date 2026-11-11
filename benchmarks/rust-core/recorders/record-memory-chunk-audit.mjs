#!/usr/bin/env node
// Case 81 of Node's chunk audit tests (src/runtime/memory/lib/memory-chunk-audit.test.mjs, "compact session retrieval
// includes the original root as a member without requiring includeMembers") from the real `createQueryHandlers`
// `recallSessionRows` with `compactHandoff: true`. The database is a scripted `getDb().query` (the test file's own
// fake: it answers the member query with the rows its SQL predicate selects, the root query with the verified root) and
// records every statement (text and params) in order. The other cases of the file are listed in the manifest:
// All five cases are recorded here (38, 55, 65, 101 added).
//
//   node benchmarks/rust-core/recorders/record-memory-chunk-audit.mjs --tree <dir>
import { begin, capture, finish, freezeClock, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = 1_700_000_000_000;
freezeClock(CLOCK_MS); // makeChunkQuality stamps verifiedAt
const dir = 'src/runtime/memory/lib/';
const { assessChunkQuality, makeChunkQuality } = await importFrom(ctx.tree, `${dir}memory-chunk-quality.mjs`);
const { auditChunkEntries, collectChunkRoots } = await importFrom(ctx.tree, `${dir}memory-chunk-audit.mjs`);
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
        statements.push({ sql, params });
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

// ---- cases 38, 55, 65, 101 of the test file, with its own inputs (nothing is left to another recording).
const extraCases = [];
{
  const source = entries();
  const roots = collectChunkRoots(source);
  const report = auditChunkEntries(source);
  extraCases.push({ name: 'legacy audit includes the source body on the root and reports old deferred rows separately (test line 38)', source: entries(), roots, report, sourceFirstHasMembers: source[0].members !== undefined });
}
{
  const root = collectChunkRoots(entries())[0];
  const summary = root.summary;
  const review = await capture(() => assessChunkQuality(root));
  extraCases.push({ name: 'existing good chunks are usable without an AI call or a verification record (test line 55)', root, review, summaryUnchanged: root.summary === summary, chunkQualityAfter: root.chunk_quality });
}
{
  const root = collectChunkRoots(entries())[0];
  const mixedInput = { ...root, members: [root.members[0], { ...root.members[1], session_id: 'other' }] };
  const expandedInput = { ...root, summary: `${root.members.map((member) => member.content).join('\n')}extra` };
  extraCases.push({ name: 'legacy reuse still rejects mixed sessions and expanded summaries (test line 65)', mixed: { input: mixedInput, ...(await capture(() => assessChunkQuality(mixedInput))) }, expanded: { input: expandedInput, ...(await capture(() => assessChunkQuality(expandedInput))) } });
}
{
  const captured = [];
  const db = { query: async (sql, params) => { captured.push({ sql, params }); return { rows: [] }; } };
  const handlers = createQueryHandlers({ getDb: () => db });
  const objectScope = { id: 42 };
  const first = await capture(() => handlers.readRawRowsInWindow(db, 100, 200, 10, { projectScope: 7 }));
  const second = await capture(() => handlers.readRawRowsInWindow(db, 100, 200, 10, { projectScope: objectScope }));
  extraCases.push({ name: 'raw window query binds truthy non-string projectScope at the original param slot (test line 101)', calls: [{ args: [100, 200, 10, { projectScope: 7 }], ...first }, { args: [100, 200, 10, { projectScope: objectScope }], ...second }], captured, secondParamIsTheScopeObject: captured[1].params[2] === objectScope });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-chunk-audit',
  golden: {
    domain: 'memory-chunk-audit',
    source: 'src/runtime/memory/lib/memory-chunk-audit.test.mjs',
    clock: { dateNowMs: CLOCK_MS, reason: 'verifiedAt of the chunk_quality the fixture roots carry' },
    cases: [...extraCases, { name: 'compact session retrieval includes the original root as a member without requiring includeMembers (test line 81)', session: cases[0] }, { name: 'further shapes (beyond the test file)', sessions: cases.slice(1) }],
  },
  extra: {
    entry: { runs: 'createQueryHandlers(...).recallSessionRows (query-handlers.mjs) with makeChunkQuality (memory-chunk-quality.mjs) building the root verification', notRun: 'a real database: getDb().query is the test file\'s fake and answers by SQL text; the real PG statements are replayed by the recall goldens' },
    replay: "mixdog-services memory/recall/browse.rs: pub fn search_by_ids (:751) with include_root_source (:827), reached by the `memory/recall` request (Recall::recall, recall/mod.rs:240); a replay compares the returned compact session text including the root",
    exclusions: 'none: all five cases of the file are recorded. Case 38 (auditChunkEntries / collectChunkRoots, a maintenance diagnostic) and case 101 (a non-string projectScope bound as is, a JS typing artefact) have no Rust counterpart that a client reaches: they are listed as work for the Rust side only if parity is wanted',
    normalised: { verifiedAt: 'Date.now() fixed at clock.dateNowMs (virtual clock, never advanced)' },
  },
});
process.exit(0);
