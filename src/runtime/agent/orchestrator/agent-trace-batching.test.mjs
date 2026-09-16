import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('runtime traces join array batches to settled eager, failed serial and cached calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-batch-trace-'));
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { recordToolBatch } from './src/runtime/agent/orchestrator/tools/tool-batch-trace.mjs';
      import { processToolBatch } from './src/runtime/agent/orchestrator/session/tool-batch.mjs';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      const sessionId = 'batch-trace-test';
      const calls = [
        { id: 'read', name: 'read', arguments: {
          file_path: Array.from({ length: 8 }, (_, i) => 'PRIVATE_PAYLOAD_' + i),
        } },
        { id: 'git', name: 'git', arguments: {
          command: ['git status', 'git diff', 'git log -1', 'git show PRIVATE_PAYLOAD'],
        } },
        { id: 'grep', name: 'grep', arguments: { pattern: ['one', 'two'], path: ['a', 'b', 'c'] } },
      ];
      const original = structuredClone(calls);
      const batchId = recordToolBatch(sessionId, calls, 4);
      assert.deepEqual(calls, original);
      const pending = new Map();
      const releases = [];
      for (const call of calls) {
        const entry = { startedAt: 100, dispatchStartedAt: 100, executionStartedAt: null,
          endedAt: null, mutationEpoch: 0 };
        entry.promise = new Promise(resolve => releases.push((start, end, outcome) => {
          entry.executionStartedAt = start;
          entry.endedAt = end;
          resolve(outcome);
        }));
        pending.set(call.id, entry);
      }
      const base = (calls, id, pending = new Map()) => ({
        calls, toolBatchId: id, pending, messages: [], tools: [], cwd: process.cwd(),
        sessionId, sessionRef: { agent: 'lead' }, signal: null, opts: {}, iterations: 4,
        assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
        epoch: { mutation: 0 }, startEagerRun: () => {}, crossTurnCalls: new Map(),
        crossTurnCap: 100, sessionAgent: null, pushToolResultMessage: () => {},
        throwIfAborted: () => {}, repeatFailLimit: 3, dedupStubTotal: 0, editCount: 0,
        executeToolFn: async () => { throw new Error('controlled serial failure'); },
      });
      const processing = processToolBatch(base(calls, batchId, pending));
      // The first eager call is awaiting settlement when these timestamps arrive.
      releases[0](120, 170, { ok: true, value: 'read result' });
      releases[1](150, 190, { ok: false, error: new Error('controlled eager failure') });
      releases[2](190, 210, { ok: true, value: 'grep result' });
      await processing;
      const serial = [{ id: 'serial', name: 'shell', arguments: { command: 'not executed' } }];
      const serialId = recordToolBatch(sessionId, serial, 5);
      await processToolBatch(base(serial, serialId));
      const cachedId = recordToolBatch(sessionId, [
        { id: 'cached', name: 'read', arguments: { file_path: 'cached.txt' } },
      ], 6);
      traceAgentTool({ sessionId, toolName: 'read', toolKind: 'builtin', toolMs: 0,
        toolBatchId: cachedId, toolCallId: 'cached', executionIntervals: [],
        resultKind: 'cache-hit', resultText: 'cached body' });
      recordToolBatch(sessionId, 2);
      await drainAgentTrace();
      const rows = readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8')
        .split(/\\r?\\n/).filter(Boolean).map(JSON.parse);
      process.stdout.write(JSON.stringify(rows.filter(row => row.kind === 'batch' || row.kind === 'tool')
        .map(row => ({ kind: row.kind, tool_name: row.tool_name, result_kind: row.result_kind, payload: row.payload }))));
    `,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          MIXDOG_AGENT_TRACE_PATH: join(dir, 'agent-trace.jsonl'),
          MIXDOG_AGENT_TRACE_DISABLE: '',
          MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
          MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
        },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const rows = JSON.parse(child.stdout);
    const batches = rows.filter((row) => row.kind === 'batch');
    const first = batches[0].payload;
    assert.equal(first.batch_schema_version, 1);
    assert.equal(first.iteration, 4);
    assert.equal(first.tool_call_count, 3);
    assert.deepEqual(
      first.calls.map((call) => call.array_lengths),
      [{ file_path: 8 }, { command: 4 }, { pattern: 2, path: 3 }]
    );
    assert.equal(JSON.stringify(batches).includes('PRIVATE_PAYLOAD'), false);
    assert.notEqual(first.batch_id, batches[1].payload.batch_id);
    assert.equal(batches[1].payload.calls[0].array_lengths, null);
    assert.deepEqual(batches[2].payload.calls[0].array_lengths, {});
    assert.deepEqual(batches[3].payload, { tool_call_count: 2 });
    const tools = rows.filter((row) => row.kind === 'tool');
    const read = tools.find((row) => row.payload.batch.tool_call_id === 'read');
    assert.equal(read.payload.batch.batch_id, first.batch_id);
    assert.deepEqual(read.payload.execution_intervals, [{ started_at_ms: 120, completed_at_ms: 170 }]);
    const git = tools.find((row) => row.payload.batch.tool_call_id === 'git');
    assert.equal(git.result_kind, 'error');
    assert.deepEqual(git.payload.execution_intervals, [{ started_at_ms: 150, completed_at_ms: 190 }]);
    const serial = tools.find((row) => row.payload.batch.tool_call_id === 'serial');
    assert.equal(serial.result_kind, 'error');
    assert.equal(serial.payload.execution_intervals.length, 1);
    assert.ok(serial.payload.execution_intervals[0].started_at_ms > 0);
    assert.ok(
      serial.payload.execution_intervals[0].completed_at_ms >= serial.payload.execution_intervals[0].started_at_ms
    );
    const cached = tools.find((row) => row.payload.batch.tool_call_id === 'cached');
    assert.deepEqual(cached.payload.execution_intervals, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
