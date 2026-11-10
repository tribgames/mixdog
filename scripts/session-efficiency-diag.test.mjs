import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addSession, buildReport, createSummary } from './session-efficiency-diag.mjs';

const assistant = (toolCalls, content = '') => ({ role: 'assistant', content, toolCalls });
const tool = (toolCallId, content) => ({ role: 'tool', toolCallId, content });

function sampleSession() {
  return {
    agent: 'lead',
    model: 'model-x',
    lastContextTokens: 1000,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'run the tests' },
      assistant([{ id: 'c1', name: 'shell', arguments: { command: 'npm test', wait_ms: 1000 } }]),
      tool('c1', 'background task\ntask_id: job_1\nstatus: running\nstarted: 2026-01-01T00:00:00.000Z'),
      assistant([{ id: 'c2', name: 'task', arguments: { action: 'wait', task_id: 'job_1' } }]),
      tool(
        'c2',
        'background task\ntask_id: job_1\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:03.000Z\n\n[stdout]\nok'
      ),
      assistant([
        { id: 'c3', name: 'read', arguments: { file_path: 'a.mjs' } },
        { id: 'c4', name: 'grep', arguments: { pattern: 'x' } },
      ]),
      tool('c3', 'x'.repeat(400)),
      tool('c4', 'y'.repeat(100)),
      assistant([], 'done'),
    ],
  };
}

test('requests, call batching and the shell foreground window are counted per session', () => {
  const summary = createSummary();
  addSession(summary, sampleSession());
  const report = buildReport(summary);
  assert.equal(report.sessions, 1);
  assert.equal(report.requests, 4);
  const [group] = report.groups;
  assert.equal(group.name, 'lead @model-x');
  assert.equal(group.callsPerToolRequest, 1.33);
  assert.equal(group.singleCallPct, 66.7);
  assert.deepEqual(report.shell, {
    calls: 1,
    promoted: 1,
    waitUnderDefault: 1,
    waitUnderDefaultPromoted: 1,
    waitUnderDefaultTimed: 1,
    waitUnderDefaultFinishedInsideDefault: 1,
    taskWaitOnlyRequests: 1,
    taskWaitOnlyPct: 25,
  });
});

test('a result is weighted by the requests that re-send it', () => {
  const summary = createSummary();
  addSession(summary, sampleSession());
  const report = buildReport(summary);
  // Both file results precede exactly one later request, so their carry is
  // proportional to their size.
  const read = report.tools.find((row) => row.name === 'read');
  const grep = report.tools.find((row) => row.name === 'grep');
  assert.equal(read.avgResultBytes, 400);
  assert.equal(Math.round(read.carryPct / grep.carryPct), 4);
  assert.equal(
    report.requestContext.reduce((sum, row) => sum + row.requestPct, 0),
    100
  );
});

test('a session without model requests is ignored', () => {
  const summary = createSummary();
  addSession(summary, { agent: 'lead', model: 'model-x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(buildReport(summary).sessions, 0);
});
