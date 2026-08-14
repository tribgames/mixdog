import test from 'node:test';
import assert from 'node:assert/strict';
import { insertAgentCalls, insertTraceEvents } from './trace-store.mjs';

const toolError = {
  ts: 1_786_000_000_000,
  session_id: 'trace-error-test',
  iteration: 3,
  kind: 'tool',
  tool_name: 'glob',
  tool_kind: 'builtin',
  tool_ms: 12,
  tool_args: { pattern: '**/*.mjs' },
  result_kind: 'error',
  result_error_category: 'runtime/failure',
  result_error_first_line: 'Error: diagnostic probe',
  payload: {},
};

test('trace_events persists tool result metadata', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };

  await insertTraceEvents(db, [toolError]);
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  const columns = sql.match(/trace_events \(([^)]+)\)/)?.[1].split(',').map((part) => part.trim()) || [];
  assert.equal(params[columns.indexOf('result_kind')], 'error');
  assert.equal(params[columns.indexOf('result_error_category')], 'runtime/failure');
  assert.equal(params[columns.indexOf('result_error_first_line')], 'Error: diagnostic probe');
});

test('agent_calls persists tool result metadata', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const db = { _pool: { connect: async () => client } };

  const result = await insertAgentCalls(db, [toolError]);
  assert.deepEqual(result, { calls: 1, llm: 0 });
  const insert = calls.find(({ sql }) => sql.includes('INSERT INTO agent_calls'));
  assert.ok(insert);
  assert.match(insert.sql, /result_kind,result_error_category,result_error_first_line/);
  assert.deepEqual(insert.params[7], ['error']);
  assert.deepEqual(insert.params[8], ['runtime/failure']);
  assert.deepEqual(insert.params[9], ['Error: diagnostic probe']);
});
