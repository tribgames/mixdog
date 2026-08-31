import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueTraceEvents,
  insertAgentCalls,
  insertTraceEvents,
  pruneAgedTraceRows,
  registerTraceExitDrain,
} from './trace-store.mjs';

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

test('disabled trace sinks are observable no-ops', async () => {
  assert.deepEqual(await insertTraceEvents(null, [toolError]), { inserted: 0 });
  assert.deepEqual(await insertAgentCalls(null, [toolError]), { calls: 0, llm: 0 });
  assert.doesNotThrow(() => enqueueTraceEvents(null, [toolError]));
  assert.doesNotThrow(() => registerTraceExitDrain(null));
});

test('seven-day trace retention deletes in bounded batches', async () => {
  const nowMs = 1_786_500_000_000;
  const calls = [];
  let traceBatch = 0;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM trace_events')) {
        traceBatch += 1;
        return { rowCount: traceBatch === 1 ? 5000 : 7 };
      }
      return { rowCount: 0 };
    },
  };

  await pruneAgedTraceRows(client, nowMs);

  const traceDeletes = calls.filter(({ sql }) => sql.includes('DELETE FROM trace_events'));
  assert.equal(traceDeletes.length, 2);
  assert.deepEqual(traceDeletes[0].params, [nowMs - 7 * 86_400_000, 5000]);
  assert.ok(calls.some(({ sql }) => sql.includes('DELETE FROM agent_calls')));
  assert.ok(calls.every(({ params }) => params?.[1] === 5000));
});
