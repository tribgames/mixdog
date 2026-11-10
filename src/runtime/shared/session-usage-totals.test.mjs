import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAgentList } from '../../session-runtime/services/agent-tool/job-views/agent-list.mjs';
import { usageDeltaEvent } from '../agent/orchestrator/session/loop/usage.mjs';
import { applyAskTerminalUsageTotals } from '../agent/orchestrator/session/manager/usage-metrics.mjs';
import { listStoredAgentWorkers } from '../agent/orchestrator/session/store-summary-reader.mjs';
import { sessionUsageTotals } from './session-usage-totals.mjs';

test('session counters become cumulative pool totals, unknown stays null', () => {
  assert.deepEqual(sessionUsageTotals({ totalInputTokens: 120, totalOutputTokens: 30, totalToolCalls: 7 }), {
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    toolCalls: 7,
  });
  assert.deepEqual(sessionUsageTotals({ totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0 }), {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCalls: 0,
  });
  // A legacy session has tokens but never counted tool calls.
  assert.deepEqual(sessionUsageTotals({ totalInputTokens: 5, totalOutputTokens: 1 }), {
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    toolCalls: null,
  });
  for (const unknown of [null, undefined, {}, { totalInputTokens: 'x', totalToolCalls: -1 }]) {
    assert.deepEqual(sessionUsageTotals(unknown), { usage: null, toolCalls: null });
  }
});

test('tool calls accumulate per provider response and are not recounted at turn end', () => {
  const session = { provider: 'openai', totalInputTokens: 0, totalOutputTokens: 0 };
  const usage = { inputTokens: 10, outputTokens: 2 };
  const delta = (toolCalls) =>
    usageDeltaEvent({ sessionId: 's', iterationIndex: 1, requestedModel: 'm', model: 'm', usage, toolCalls });
  assert.equal(delta(3).deltaToolCalls, 3);
  assert.equal(delta(undefined).deltaToolCalls, 0);
  // Terminal fallback (no per-iteration persistence) adds the turn's calls once.
  applyAskTerminalUsageTotals(session, { usage, toolCallsTotal: 4 });
  assert.equal(session.totalToolCalls, 4);
  applyAskTerminalUsageTotals(session, { usage, toolCallsTotal: 4 }, { skipTotalsIfIncremental: true });
  assert.equal(session.totalToolCalls, 4);
});

test('the stored agent pool rows carry the session totals', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-pool-usage-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    // Settled agents are listed only inside the pane window after they finish.
    const stamp = new Date().toISOString();
    const write = (id, extra) =>
      writeFileSync(
        join(root, 'sessions', `${id}.json`),
        JSON.stringify({ id, owner: 'agent', agent: 'reviewer', createdAt: stamp, updatedAt: stamp, ...extra })
      );
    write('usage-child', { totalInputTokens: 900, totalOutputTokens: 100, totalToolCalls: 12 });
    write('usage-legacy', {});
    assert.equal(existsSync(join(root, 'sessions', 'usage-child.json')), true);
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: [
          { sessionId: 'usage-child', tag: 'a', agent: 'reviewer', status: 'completed', updatedAt: stamp },
          { sessionId: 'usage-legacy', tag: 'b', agent: 'reviewer', status: 'completed', updatedAt: stamp },
        ],
      })
    );
    const rows = new Map(listStoredAgentWorkers().map((row) => [row.tag, row]));
    assert.deepEqual(rows.get('a').usage, { inputTokens: 900, outputTokens: 100, totalTokens: 1000 });
    assert.equal(rows.get('a').toolCalls, 12);
    assert.equal(rows.get('b').usage, null);
    assert.equal(rows.get('b').toolCalls, null);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the live agent list rows carry the in-memory session totals', () => {
  const session = {
    id: 'live-1',
    agent: 'worker',
    status: 'running',
    stage: 'streaming',
    totalInputTokens: 40,
    totalOutputTokens: 2,
    totalToolCalls: 5,
  };
  const list = createAgentList({
    mgr: {},
    refreshTagsFromSessions: () => {},
    agentSessionEntries: () => [{ tag: 'w', session, indexRow: null }],
    progress: { sessionProgressExtras: () => ({}) },
  });
  const [row] = list();
  assert.deepEqual(row.usage, { inputTokens: 40, outputTokens: 2, totalTokens: 42 });
  assert.equal(row.toolCalls, 5);
});
