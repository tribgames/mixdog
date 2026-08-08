import assert from 'node:assert/strict';
import {
  compactDigestRows,
  renderEntryLines,
} from '../src/runtime/memory/lib/recall-format.mjs';
import { createQueryHandlers } from '../src/runtime/memory/lib/query-handlers.mjs';

const longPlan = 'cache recent session snapshots and display immediately while the runtime initializes in the background without a blocking veil';
const nearPlan = `${longPlan} and keep the newest click authoritative`;
const rows = [
  { id: 10, ts: 300, role: 'assistant', content: nearPlan, is_root: 0, chunk_root: null },
  { id: 9, ts: 290, role: 'assistant', content: longPlan, is_root: 0, chunk_root: null },
  { id: 8, ts: 280, role: 'assistant', content: longPlan, is_root: 0, chunk_root: null },
  { id: 7, ts: 270, role: 'user', content: '오케이', is_root: 0, chunk_root: null },
  { id: 6, ts: 260, role: 'user', content: '오케이', is_root: 0, chunk_root: null },
  { id: 5, ts: 250, role: 'assistant', content: 'distinct completed result', is_root: 0, chunk_root: null },
];

const compact = compactDigestRows(rows, 30);
assert.equal(compact.filter((row) => row.content === '오케이').length, 1, 'short exact duplicates collapse');
assert.equal(compact.filter((row) => row.content === longPlan).length, 0, 'older near-duplicate plans collapse');
assert.ok(compact.some((row) => row.content === nearPlan), 'newest near-duplicate plan is retained');
assert.ok(compact.some((row) => row.content === 'distinct completed result'), 'distinct state survives');

const normalText = renderEntryLines(compact);
assert.match(normalText, /\[pending\]/, 'normal recall keeps raw-row pipeline status');
const digestText = renderEntryLines(compact, { pendingMarks: false });
assert.doesNotMatch(digestText, /\[pending\]/, 'compact digest omits misleading pipeline status');

const fakeDb = {
  async query(sql) {
    if (/SELECT source_turn t/.test(sql)) return { rows: [] };
    if (/id <> ALL/.test(sql)) return { rows: [] };
    if (/FROM entries/.test(sql)) return { rows };
    return { rows: [] };
  },
};
const { handleSearch } = createQueryHandlers({
  getDb: () => fakeDb,
  log: () => {},
  resolveProjectScope: () => null,
  embeddingWarmupCanStart: () => false,
  getBootTimestamp: () => 0,
  getTraceDb: () => null,
});
const integrated = await handleSearch({
  sessionId: 'compact-digest-session',
  limit: 30,
  includeMembers: true,
  includeRaw: true,
  compactDigest: true,
});
assert.doesNotMatch(integrated.text, /\[pending\]/, 'compact search path suppresses pipeline status');
assert.equal((integrated.text.match(/오케이/g) || []).length, 1, 'compact search path removes exact duplicates');
assert.equal((integrated.text.match(/cache recent session snapshots/g) || []).length, 1, 'compact search path removes near duplicates');

// Compaction digest must not apply the in-flight current-turn cutoff: the
// watcher-backed stored history may contain a newly finalized turn whose
// timestamp is still fresh and would otherwise be dropped from the digest.
const freshTurnRows = [
  { id: 21, ts: Date.now(), role: 'assistant', content: 'newest finalized answer', is_root: 0, chunk_root: null, source_turn: 7 },
  { id: 20, ts: Date.now() - 1000, role: 'user', content: 'older question', is_root: 0, chunk_root: null, source_turn: 6 },
];
const seenSql = [];
const freshDb = {
  // Honours the cutoff predicate the way the real DB would: when the executed
  // SQL carries `NOT (chunk_root IS NULL AND source_turn = $n)`, the excluded
  // turn's rows really disappear, so the survival assertion below fails on
  // pre-fix code instead of passing vacuously.
  async query(sql, params = []) {
    seenSql.push(sql);
    if (/SELECT source_turn t/.test(sql)) return { rows: [{ t: 7, last_ts: Date.now() }] };
    if (/id <> ALL/.test(sql)) return { rows: [] };
    if (/FROM entries/.test(sql)) {
      const cutoff = /NOT \(chunk_root IS NULL AND source_turn = \$(\d+)\)/.exec(sql);
      if (!cutoff) return { rows: freshTurnRows };
      const excluded = Number(params[Number(cutoff[1]) - 1]);
      return {
        rows: freshTurnRows.filter((row) => !(row.chunk_root == null && Number(row.source_turn) === excluded)),
      };
    }
    return { rows: [] };
  },
};
const freshHandlers = createQueryHandlers({
  getDb: () => freshDb,
  log: () => {},
  resolveProjectScope: () => null,
  embeddingWarmupCanStart: () => false,
  getBootTimestamp: () => 0,
  getTraceDb: () => null,
});
const digest = await freshHandlers.handleSearch({
  sessionId: 'compact-digest-fresh-session',
  limit: 30,
  includeRaw: true,
  compactDigest: true,
});
assert.match(digest.text, /newest finalized answer/, 'compact digest keeps the newest finalized turn');
assert.ok(
  !seenSql.some((sql) => /GROUP BY source_turn/.test(sql)),
  'compact digest never issues the current-turn discovery query',
);
assert.ok(
  !seenSql.some((sql) => /NOT \(chunk_root IS NULL AND source_turn/.test(sql)),
  'compact digest never applies the current-turn cutoff clause',
);

const ALL_RECALL_CATEGORIES = [
  'rule',
  'constraint',
  'decision',
  'fact',
  'goal',
  'preference',
  'task',
  'issue',
];
function createLastBrowseDb(rawRow, seenQueries) {
  return {
    async transaction(run) {
      return run(this);
    },
    async query(sql, params = []) {
      seenQueries.push({ sql, params });
      if (/GROUP BY session_id/.test(sql)) {
        return {
          rows: [{
            session_id: rawRow.session_id,
            first_ts: rawRow.ts,
            last_ts: rawRow.ts,
          }],
        };
      }
      if (/WHERE is_root = \$1/.test(sql)) return { rows: [] };
      if (/chunk_root IS NULL/.test(sql) && /is_root = 0/.test(sql)) return { rows: [rawRow] };
      return { rows: [] };
    },
  };
}
function createLastBrowseHandlers(db) {
  return createQueryHandlers({
    getDb: () => db,
    log: () => {},
    resolveProjectScope: () => null,
    embeddingWarmupCanStart: () => false,
    getBootTimestamp: () => 0,
    getTraceDb: () => null,
  });
}

const allCategoryQueries = [];
const allCategoryRaw = {
  id: 31,
  ts: Date.now() - 1000,
  role: 'assistant',
  content: 'fresh pending restart context',
  session_id: 'recent-all-category-session',
  source_turn: 9,
  chunk_root: null,
  is_root: 0,
  category: null,
};
const allCategoryBrowse = await createLastBrowseHandlers(
  createLastBrowseDb(allCategoryRaw, allCategoryQueries),
).handleSearch({
  query: 'restart context',
  period: 'last',
  limit: 1,
  includeMembers: true,
  includeRaw: true,
  category: ALL_RECALL_CATEGORIES,
  projectScope: 'mixdog',
});
assert.match(allCategoryBrowse.text, /fresh pending restart context/, 'all categories keep fresh unclassified raw turns');
assert.doesNotMatch(allCategoryBrowse.text, /0 entries/, 'all-category browse never emits an empty selected session');
const allCategorySelection = allCategoryQueries.find(({ sql }) => /GROUP BY session_id/.test(sql));
assert.ok(allCategorySelection, 'all-category browse selects recent sessions');
assert.doesNotMatch(allCategorySelection.sql, /coalesce\(category/, 'all categories normalize to an unrestricted session query');

const subsetCategoryQueries = [];
const subsetCategoryRaw = {
  ...allCategoryRaw,
  id: 32,
  content: 'fresh decision restart context',
  session_id: 'recent-decision-session',
  category: 'decision',
};
const subsetCategoryBrowse = await createLastBrowseHandlers(
  createLastBrowseDb(subsetCategoryRaw, subsetCategoryQueries),
).handleSearch({
  query: 'restart context',
  period: 'last',
  limit: 1,
  includeMembers: true,
  includeRaw: true,
  category: ['decision'],
  projectScope: 'mixdog',
});
assert.match(subsetCategoryBrowse.text, /fresh decision restart context/, 'subset category keeps matching raw turns');
const subsetCategorySelection = subsetCategoryQueries.find(({ sql }) => /GROUP BY session_id/.test(sql));
assert.ok(subsetCategorySelection, 'subset-category browse selects recent sessions');
assert.match(subsetCategorySelection.sql, /lower\(coalesce\(category, ''\)\) IN/, 'subset category filters session selection');
assert.ok(subsetCategorySelection.params.includes('decision'), 'subset category selection binds the requested category');

console.log('compact recall digest test passed \u2713');
