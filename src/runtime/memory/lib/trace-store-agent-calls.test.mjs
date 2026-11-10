import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { insertAgentCalls } from './trace-store.mjs';

function fakeDb(failOn = null) {
  const calls = [];
  let released = 0;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (failOn && sql.includes(failOn)) throw new Error(`boom ${failOn}`);
      return { rowCount: 1, rows: [] };
    },
    release() {
      released += 1;
    },
  };
  return { db: { _pool: { connect: async () => client } }, calls, released: () => released };
}
const find = (calls, needle) => calls.find(({ sql }) => sql.includes(needle));
const statements = (calls) =>
  calls
    .map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' '))
    .filter((s) => /^(BEGIN|COMMIT|ROLLBACK|INSERT)/.test(s));

test('insertAgentCalls batches tool/llm rows and folds one agent_sessions upsert per session', async () => {
  const { db, calls, released } = fakeDb();
  const events = [
    {
      kind: 'tool',
      session_id: 'A',
      iteration: 1,
      ts: '2026-01-01T00:00:10.000Z',
      tool_name: 'read',
      tool_kind: 'builtin',
      tool_ms: '5',
      tool_args: 'src/a.mjs',
      result_kind: 'ok',
    },
    {
      kind: 'tool',
      sessionId: 'A',
      iteration: 4,
      ts: Date.parse('2026-01-01T00:00:00.000Z'),
      toolName: 'grep',
      toolKind: 'builtin',
      toolMs: 7,
      toolArgs: { pattern: 'x' },
      resultKind: 'error',
      resultErrorCategory: 'runtime/failure',
      resultErrorFirstLine: 'Error: nope',
    },
    {
      kind: 'usage_raw',
      session_id: 'A',
      iteration: 2,
      ts: '2026-01-01T00:00:05.000Z',
      model: 'm-a',
      input_tokens: 100,
      output_tokens: 20,
      cached_tokens: 3,
      cache_write_tokens: 1,
      prompt_tokens: 103,
      response_id: 'r1',
    },
    { session_id: 'B', iteration: 0, ts: '2026-01-02T00:00:00.000Z', model: 'm-b', input_tokens: 7, output_tokens: 1 },
    // Kind-less usage is recognised by its snake_case token fields only.
    { sessionId: 'D', ts: 1, inputTokens: 1, outputTokens: 1 },
    { kind: 'preset_assign', session_id: 'A', agent: 'lead' },
    { kind: 'preset_assign', session_id: 'C', agent: 'worker', model: 'm-c', ts: '2026-01-03T00:00:00.000Z' },
    { kind: 'preset_assign', session_id: 'C', agent: 'later' },
    { kind: 'tool', iteration: 1, ts: 1, tool_name: 'no-session' },
  ];

  assert.deepEqual(await insertAgentCalls(db, events), { calls: 2, llm: 2 });
  assert.equal(released(), 1);
  assert.deepEqual(statements(calls), [
    'BEGIN',
    'INSERT INTO agent_calls',
    'INSERT INTO agent_llm',
    'INSERT INTO agent_sessions',
    'COMMIT',
  ]);

  const tools = find(calls, 'INSERT INTO agent_calls').params;
  assert.deepEqual(tools[0], ['A', 'A']);
  assert.deepEqual(tools[1], [1, 4]);
  assert.deepEqual(tools[2], ['2026-01-01T00:00:10.000Z', '2026-01-01T00:00:00.000Z']);
  assert.deepEqual(tools[3], ['read', 'grep']);
  assert.deepEqual(tools[5], [5, 7]);
  assert.deepEqual(tools[6], ['"src/a.mjs"', '{"pattern":"x"}']);
  assert.deepEqual(tools[7], ['ok', 'error']);
  assert.deepEqual(tools[9], [null, 'Error: nope']);

  const llm = find(calls, 'INSERT INTO agent_llm').params;
  assert.deepEqual(llm[0], ['A', 'B']);
  assert.deepEqual(llm[3], ['m-a', 'm-b']);
  assert.deepEqual(llm[4], [100, 7]);
  assert.deepEqual(llm[6], [3, null]);
  assert.deepEqual(llm[9], ['r1', null]);

  assert.deepEqual(find(calls, 'INSERT INTO agent_sessions').params, [
    ['A', 'B', 'C'],
    ['lead', null, 'worker'],
    ['m-a', 'm-b', 'm-c'],
    ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'],
    ['2026-01-01T00:00:10.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'],
    [2, 0, 0],
    [1, 1, 0],
    [4, 0, 0],
    ['100', '7', '0'],
    ['20', '1', '0'],
  ]);
});

test('insertAgentCalls caps oversized tool args and rolls back a failed batch', async () => {
  const big = 'x'.repeat(70_000);
  const { db, calls } = fakeDb();
  await insertAgentCalls(db, [{ kind: 'tool', session_id: 'A', ts: 1, tool_name: 't', tool_args: { big } }]);
  const [args] = find(calls, 'INSERT INTO agent_calls').params[6];
  const raw = JSON.stringify({ big });
  assert.deepEqual(JSON.parse(args), {
    _oversized: true,
    sha256: createHash('sha256').update(raw).digest('hex'),
    preview: raw.slice(0, 512),
  });

  const failing = fakeDb('agent_llm');
  await assert.rejects(
    () =>
      insertAgentCalls(failing.db, [{ kind: 'usage_raw', session_id: 'A', ts: 1, input_tokens: 1, output_tokens: 1 }]),
    /boom agent_llm/
  );
  assert.deepEqual(statements(failing.calls), ['BEGIN', 'INSERT INTO agent_llm', 'ROLLBACK']);
  assert.equal(failing.released(), 1);
});
