import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateToolCategoryEntry,
  formatAggregateHeader,
  summarizeToolArgs,
  toolWorkUnit,
} from '../src/runtime/shared/tool-surface.mjs';
import {
  normalizeToolTerminalStatus,
  toolResultTerminalStatus,
} from '../src/runtime/shared/tool-status.mjs';
import {
  aggregateBucketForCategory,
  toolCallOutcome,
} from '../src/tui/engine/tool-result-status.mjs';
import { createToolCardResults } from '../src/tui/engine/tool-card-results.mjs';
import {
  appendAgentResponseTail,
  formatAgentResponseRaw,
} from '../src/tui/engine/agent-response-tail.mjs';

test('tool action copy keeps Add/Delete patch verbs and human read offsets', () => {
  assert.equal(
    toolWorkUnit('apply_patch', { patch: '*** Begin Patch\n*** Add File: new.mjs\n+x\n*** End Patch' }).done,
    'Created',
  );
  assert.equal(
    toolWorkUnit('apply_patch', { patch: '*** Begin Patch\n*** Delete File: old.mjs\n*** End Patch' }).active,
    'Deleting',
  );
  assert.match(summarizeToolArgs('read', { path: 'a.mjs', offset: 0, limit: 10 }), /lines 1-10/);
});

test('Agent aggregation is batch-scoped and keeps category action wording', () => {
  const entry = aggregateToolCategoryEntry('agent', { type: 'spawn' }, 'Agent');
  assert.equal(formatAggregateHeader({ [entry.key]: { ...entry, count: 2 } }, { pending: false }), 'Called 2 agents');
  assert.notEqual(
    aggregateBucketForCategory('Agent', { agentBatch: 1 }),
    aggregateBucketForCategory('Agent', { agentBatch: 2 }),
  );
});

test('terminal result statuses stay separate from tool-call failure accounting', () => {
  assert.equal(normalizeToolTerminalStatus('denied'), 'denied');
  assert.equal(toolResultTerminalStatus('[status: cancelled]\n'), 'cancelled');

  const state = {
    items: [{
      id: 'aggregate',
      kind: 'tool',
      result: null,
      count: 1,
      completedCount: 0,
    }],
  };
  const aggregate = {
    itemId: 'aggregate',
    calls: new Map([['call_1', { name: 'web_fetch', args: {}, category: 'Web Research' }]]),
    nextSummarySeq: 0,
    ensureVisible: () => {},
  };
  const { patchToolCardResult } = createToolCardResults({
    getState: () => state,
    set: () => {},
    patchItem: (id, patch) => {
      const index = state.items.findIndex((item) => item.id === id);
      state.items[index] = { ...state.items[index], ...patch };
      return true;
    },
    markToolCallDone: () => {},
    updateAgentJobCard: () => {},
    buildAgentJobCardPatch: () => ({}),
    agentStatusState: () => ({}),
  });
  const card = { itemId: 'aggregate', callId: 'call_1', done: false, aggregate };
  assert.equal(patchToolCardResult(card, {
    tool_call_id: 'call_1',
    content: 'status: failed\nHTTP 404 Not Found',
  }, new Map(), new Set()), true);
  assert.equal(state.items[0].errorCount, 0);
  assert.equal(state.items[0].callErrorCount, 0);
  assert.equal(aggregate.calls.get('call_1').isError, false);
});

function patchAggregate(messages) {
  const state = { items: [{ id: 'aggregate', kind: 'tool', result: null, count: messages.length, completedCount: 0 }] };
  const aggregate = {
    itemId: 'aggregate',
    calls: new Map(messages.map((message) => [message.tool_call_id, {
      name: 'shell',
      args: {},
      category: 'Shell',
    }])),
    nextSummarySeq: 0,
    ensureVisible: () => {},
  };
  const { patchToolCardResult } = createToolCardResults({
    getState: () => state,
    set: () => {},
    patchItem: (id, patch) => {
      const index = state.items.findIndex((item) => item.id === id);
      state.items[index] = { ...state.items[index], ...patch };
      return true;
    },
    markToolCallDone: () => {},
    updateAgentJobCard: () => {},
    buildAgentJobCardPatch: () => ({}),
    agentStatusState: () => ({}),
  });
  for (const message of messages) {
    patchToolCardResult(
      { itemId: 'aggregate', callId: message.tool_call_id, done: false, aggregate },
      message,
      new Map(),
      new Set(),
    );
  }
  return state.items[0];
}

test('exit detail stays successful and does not inflate Ok or Failed counts', () => {
  const exit = 'Error: [shell-run-failed] [exit code: 1]\ncommand output';
  const exitOnly = patchAggregate([{ tool_call_id: 'exit', content: exit, toolKind: 'error' }]);
  assert.equal(exitOnly.errorCount, 0);
  assert.equal(exitOnly.callErrorCount, 0);
  assert.equal(exitOnly.exitErrorCount, 1);
  assert.equal(exitOnly.result, 'Exit 1');

  const mixed = patchAggregate([
    { tool_call_id: 'failed', content: 'transport unavailable', isError: true },
    { tool_call_id: 'exit', content: exit, isError: true },
  ]);
  assert.equal(mixed.errorCount, 1);
  assert.equal(mixed.callErrorCount, 1);
  assert.equal(mixed.exitErrorCount, 1);
  assert.equal(mixed.result, '1 Failed · 1 Exit');
});

test('eager call outcome uses only envelope failure metadata', () => {
  const exit = 'Error: [shell-run-failed] [exit code: 1]';
  assert.equal(toolCallOutcome({ content: 'Error: domain failure' }, 'Error: domain failure').isCallError, false);
  assert.equal(toolCallOutcome({ isError: true, content: 'ok-looking body' }, 'ok-looking body').isCallError, true);
  assert.deepEqual(toolCallOutcome({ toolKind: 'error' }, exit), { isCallError: false, isExitError: true, exitCode: 1 });
  assert.deepEqual(toolCallOutcome({ isError: true }, exit), { isCallError: false, isExitError: true, exitCode: 1 });
  assert.equal(toolCallOutcome({ isError: true }, 'Error: [shell-run-failed] [timeout: 1s]').isCallError, true);
});

test('tail response aggregation is ordered, idempotent, and boundary-safe', () => {
  const first = {
    kind: 'tool',
    agentDirection: 'inbound',
    agentResponseKey: 'one',
    agentResponseHasBody: true,
    agentResponseEntries: [{ key: 'one', raw: 'body one', result: 'one', hasBody: true, isError: false }],
  };
  const secondPatch = appendAgentResponseTail(first, {
    key: 'two', args: { type: 'result' }, rawResult: 'body two', result: 'two', hasBody: true,
  }, 1);
  const second = { ...first, ...secondPatch };
  const thirdPatch = appendAgentResponseTail(second, {
    key: 'three', args: { type: 'result' }, rawResult: 'body three', result: 'three', hasBody: true,
  }, 2);
  assert.equal(thirdPatch.count, 3);
  assert.equal(
    thirdPatch.rawResult,
    '1. agent\nbody one\n\n2. agent\nbody two\n\n3. agent\nbody three',
  );
  const retryPatch = appendAgentResponseTail({ ...second, ...thirdPatch }, {
    key: 'two', args: { type: 'result' }, rawResult: 'body two retry', result: 'two retry', hasBody: true,
  }, 3);
  assert.equal(retryPatch.count, 3);
  assert.match(retryPatch.rawResult, /2\. agent\nbody two retry/);
  assert.equal(appendAgentResponseTail({ kind: 'user' }, {
    key: 'four', rawResult: 'body four', result: 'four', hasBody: true,
  }), null);
  assert.equal(formatAgentResponseRaw(retryPatch.agentResponseEntries).match(/\d+\. agent/g).length, 3);
});

test('failure preview upgrades its tail entry, but a boundary forces a new body card', () => {
  const failurePreview = {
    kind: 'tool',
    agentDirection: 'inbound',
    agentResponseKey: 'task_1',
    agentResponseHasBody: false,
    agentResponseEntries: [{
      key: 'task_1', raw: 'failed preview', result: 'failed', hasBody: false, isError: true,
    }],
  };
  const upgrade = appendAgentResponseTail(failurePreview, {
    key: 'task_1', args: { type: 'result' }, rawResult: 'final body', result: 'final', hasBody: true, isError: false,
  }, 1);
  assert.equal(upgrade.count, 1);
  assert.equal(upgrade.rawResult, '1. agent\nfinal body');
  assert.equal(upgrade.isError, false);

  const boundary = appendAgentResponseTail({ kind: 'assistant', text: 'intervening text' }, {
    key: 'task_1', args: { type: 'result' }, rawResult: 'final body', result: 'final', hasBody: true,
  });
  assert.equal(boundary, null);
});
