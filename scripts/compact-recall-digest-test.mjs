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

console.log('compact recall digest test passed \u2713');
