import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { renderEntryLines, renderSessionGroupedLines } from './recall-format.mjs';
import { compactHandoffRows } from './compact-handoff.mjs';

mock.module('./memory-recall-store.mjs', {
  namedExports: { searchRelevantHybrid: (db, query, options) => db.search(query, options) },
});
const { createQueryHandlers } = await import('./query-handlers.mjs');

const body = (label) =>
  `\`\`\`js\nconst ${label} = 7319;\n\`\`\`\nhttps://example.com/${label}\n| ${label} | required |`;
const root = {
  id: 1,
  ts: Date.now() - 2000,
  role: 'user',
  is_root: 1,
  chunk_root: 1,
  session_id: 'source-session',
  element: 'decision',
  summary: 'Compact summary only.',
  content: body('ROOT_SOURCE'),
};
const member = {
  id: 2,
  ts: root.ts + 1,
  role: 'assistant',
  is_root: 0,
  chunk_root: 1,
  session_id: root.session_id,
  content: body('MEMBER_SOURCE'),
};
const raw = {
  id: 3,
  ts: root.ts + 2,
  role: 'user',
  is_root: 0,
  chunk_root: null,
  session_id: root.session_id,
  content: body('RAW_SOURCE'),
};

function handlers(rows = [root, member, raw]) {
  const [rootRow, memberRow, rawRow] = rows;
  const db = {
    async search(_query, options) {
      return [{ ...rootRow, ...(options.includeMembers ? { members: [{ ...memberRow }] } : {}) }, { ...rawRow }];
    },
    async query(sql, params = []) {
      if (sql.includes('FROM entries WHERE id = ANY')) {
        return { rows: rows.filter((row) => params[0].includes(row.id)).map((row) => ({ ...row })) };
      }
      if (sql.includes('WHERE chunk_root = ANY')) {
        const selected = sql.includes('is_root = 0') ? [memberRow] : [rootRow, memberRow];
        return { rows: selected.map((row) => ({ ...row })) };
      }
      if (sql.includes('id <> ALL')) return { rows: [] };
      if (sql.includes('WHERE session_id = $1')) return { rows: [{ ...rootRow }, { ...rawRow }] };
      return { rows: [] };
    },
    transaction: (run) => run(db),
  };
  return createQueryHandlers({
    getDb: () => db,
    log: () => {},
    resolveProjectScope: () => 'all',
    embeddingOnDemandCanStart: () => false,
    getBootTimestamp: () => 0,
    getTraceDb: () => null,
  });
}

test('ID recall preserves original root, member and RAW bodies without duplicating named members', async () => {
  const { text } = await handlers().handleSearch({ id: [1, 2, 3] });
  for (const row of [root, member, raw]) assert.ok(text.includes(row.content));
  assert.equal(text.split(member.content).length - 1, 1);
  assert.equal(text.includes(root.summary), false);
});

test('explicit member search and session expansion keep code, URLs and tables', async () => {
  for (const args of [
    { query: 'source evidence', period: 'all', includeMembers: true },
    { sessionId: root.session_id, includeMembers: true },
  ]) {
    const { text } = await handlers().handleSearch(args);
    for (const row of [root, member, raw]) assert.ok(text.includes(row.content), JSON.stringify(args));
    assert.equal(text.split(root.content).length - 1, 1);
  }
});

test('RAW opt-in preserves raw text while the ordinary root result stays a summary', async () => {
  const h = handlers();
  const normal = await h.handleSearch({ query: 'source evidence', period: 'all' });
  assert.ok(normal.text.includes(root.summary));
  assert.equal(normal.text.includes(root.content), false);
  const expanded = await h.handleSearch({ query: 'source evidence', period: 'all', includeRaw: true });
  assert.ok(expanded.text.includes(root.summary));
  assert.ok(expanded.text.includes(raw.content));
});

test('an in-window member hit cannot reintroduce the original root body from outside the requested period', async () => {
  const oldRoot = { ...root, ts: Date.now() - 2 * 60 * 60 * 1000 };
  const { text } = await handlers([oldRoot, member, raw]).handleSearch({
    query: 'source evidence',
    period: '30m',
    includeMembers: true,
  });
  assert.ok(text.includes(member.content));
  assert.equal(text.includes(oldRoot.content), false);
});

test('grouped source rendering carries explicit options through flat, multi-session and span layouts', () => {
  for (const rows of [[raw], [raw, { ...raw, id: 4, session_id: 'other-session' }]]) {
    for (const spanHeaders of [false, true]) {
      const text = renderSessionGroupedLines(rows, { spanHeaders, preserveSource: true });
      assert.ok(text.includes(raw.content));
    }
  }
});

test('source opt-in keeps the body bound and does not change Compact summary/RAW projection', () => {
  const large = { ...raw, content: `${'x'.repeat(8000)}AFTER_BODY_BOUND` };
  assert.equal(renderEntryLines([large], { preserveSource: true }).includes('AFTER_BODY_BOUND'), false);
  assert.equal(renderEntryLines([{ ...root, _compactBody: true }]), root.summary);
  const compact = renderEntryLines(compactHandoffRows([large]), { maxBodyChars: null });
  assert.ok(compact.includes(large.content));
  assert.ok(renderEntryLines(compactHandoffRows([raw])).includes(raw.content));
});
