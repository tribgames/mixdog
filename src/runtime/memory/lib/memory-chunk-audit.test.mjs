import assert from 'node:assert/strict';
import test from 'node:test';
import { auditChunkEntries, collectChunkRoots } from './memory-chunk-audit.mjs';
import { assessChunkQuality, makeChunkQuality } from './memory-chunk-quality.mjs';
import { createQueryHandlers } from './query-handlers.mjs';

const entries = () => [
  {
    id: 1,
    ts: 1000,
    role: 'user',
    session_id: 's',
    content: 'User requires 296 failures to be reported accurately. '.repeat(20),
    is_root: 1,
    chunk_root: 1,
    summary: 'There were 296 failures.',
  },
  {
    id: 2,
    ts: 2000,
    role: 'assistant',
    session_id: 's',
    content: 'Confirmed: 296 failures, not successes. '.repeat(20),
    is_root: 0,
    chunk_root: 1,
  },
  {
    id: 3,
    ts: 3000,
    role: 'user',
    session_id: 's',
    content: 'Deferred source must remain available.',
    is_root: 0,
    chunk_root: 3,
  },
];

test('legacy audit includes the source body on the root and reports old deferred rows separately', () => {
  const source = entries();
  const roots = collectChunkRoots(source);
  assert.deepEqual(
    roots[0].members.map((row) => row.id),
    [1, 2]
  );
  const report = auditChunkEntries(source);
  assert.equal(report.entryCount, 3);
  assert.equal(report.chunkCount, 1);
  assert.equal(report.rawFallback, 0);
  assert.equal(report.reusable, 1);
  assert.equal(report.chunks[0].provenance, 'legacy');
  assert.equal(report.legacyDeferredRows, 1);
  assert.equal(source[0].members, undefined);
});

test('existing good chunks are usable without an AI call or a verification record', () => {
  const root = collectChunkRoots(entries())[0];
  const summary = root.summary;
  const review = assessChunkQuality(root);
  assert.equal(review.usable, true);
  assert.equal(root.summary, summary);
  assert.equal(root.chunk_quality, undefined);
  assert.equal(review.provenance, 'legacy');
});

test('legacy reuse still rejects mixed sessions and expanded summaries', () => {
  const root = collectChunkRoots(entries())[0];
  const mixed = assessChunkQuality({
    ...root,
    members: [root.members[0], { ...root.members[1], session_id: 'other' }],
  });
  const expanded = assessChunkQuality({
    ...root,
    summary: root.members.map((member) => member.content).join('\n') + 'extra',
  });
  assert.equal(mixed.usable, false);
  assert.ok(mixed.reasons.includes('mixed_sessions'));
  assert.equal(expanded.usable, false);
  assert.ok(expanded.reasons.includes('not_shorter'));
});

test('compact session retrieval includes the original root as a member without requiring includeMembers', async () => {
  const source = entries();
  const root = { ...source[0], chunk_quality: makeChunkQuality(source[0].summary, source.slice(0, 2)) };
  const handlers = createQueryHandlers({
    getDb: () => ({
      query: async (sql) => {
        // This fake models the SQL membership predicate, including the old
        // root-excluding bug. It does not grant unrequested member rows.
        if (sql.includes('WHERE chunk_root = ANY')) {
          const selected = sql.includes('AND is_root = 0') ? source.slice(1, 2) : source.slice(0, 2);
          return { rows: structuredClone(selected) };
        }
        return { rows: [structuredClone(root)] };
      },
    }),
  });
  const result = await handlers.recallSessionRows({ sessionId: 's', compactHandoff: true });
  assert.equal(result.text, 'There were 296 failures.');
});

test('raw window query binds truthy non-string projectScope at the original param slot', async () => {
  const captured = [];
  const db = {
    query: async (sql, params) => {
      captured.push({ sql, params });
      return { rows: [] };
    },
  };
  const handlers = createQueryHandlers({ getDb: () => db });
  const objectScope = { id: 42 };
  await handlers.readRawRowsInWindow(db, 100, 200, 10, { projectScope: 7 });
  await handlers.readRawRowsInWindow(db, 100, 200, 10, { projectScope: objectScope });
  assert.equal(captured.length, 2);
  assert.match(captured[0].sql, /project_id IS NULL OR project_id = \$3/);
  assert.deepEqual(captured[0].params, [100, 200, 7, 10]);
  assert.equal(captured[1].params[2], objectScope);
  assert.deepEqual(captured[1].params, [100, 200, objectScope, 10]);
});
