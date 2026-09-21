import assert from 'node:assert/strict';
import test from 'node:test';

import { appendAgentResponseTail } from './agent-response-tail.mjs';

test('distinct inbound responses preserve normalized raw text, numbering gaps, and counts without mutation', () => {
  const previous = Object.freeze({
    kind: 'tool',
    agentDirection: 'inbound',
    agentResponseHasBody: true,
    agentResponseEntries: Object.freeze([
      Object.freeze({ key: 'first', raw: '  one  ', result: 'old', hasBody: true, isError: 1 }),
      Object.freeze({ key: '', raw: ' \n ', result: '', hasBody: true, isError: false }),
    ]),
  });
  const response = Object.freeze({
    key: 'third',
    args: { tag: 'review' },
    rawResult: 0,
    raw: 'ignored',
    result: 'last',
    hasBody: true,
    isError: true,
  });

  assert.deepEqual(appendAgentResponseTail(previous, response, 123), {
    args: { tag: 'review' },
    result: 'last',
    rawResult: '1. agent\none\n\n3. agent\n0',
    isError: true,
    count: 3,
    completedCount: 3,
    completedAt: 123,
    agentResponseEntries: [
      { key: 'first', raw: 'one', result: 'old', hasBody: true, isError: false },
      { key: '', raw: '', result: '', hasBody: true, isError: false },
      { key: 'third', raw: '0', result: 'last', hasBody: true, isError: true },
    ],
    agentResponseKeys: ['first', 'third'],
    agentResponseHasBody: true,
    agentResponseAggregate: true,
  });
});

test('a same-key completion replaces a legacy preview across the body boundary without adding a response', () => {
  const previous = Object.freeze({
    kind: 'tool',
    agentDirection: 'inbound',
    agentResponseKey: 'task-1',
    agentResponseHasBody: false,
    result: 'preview',
    rawResult: ' preview raw ',
    isError: true,
  });
  const response = { key: 'task-1', result: 'done', raw: ' final ', hasBody: true, isError: false };

  assert.deepEqual(appendAgentResponseTail(previous, response, 456), {
    args: undefined,
    result: 'done',
    rawResult: '1. agent\nfinal',
    isError: false,
    count: 1,
    completedCount: 1,
    completedAt: 456,
    agentResponseEntries: [{ key: 'task-1', raw: 'final', result: 'done', hasBody: true, isError: false }],
    agentResponseKeys: ['task-1'],
    agentResponseHasBody: true,
    agentResponseAggregate: false,
  });
});

test('tail aggregation rejects non-inbound rows and distinct responses in another presentation phase', () => {
  const response = { key: 'next', result: 'done', hasBody: true };
  for (const previous of [
    null,
    { kind: 'user', agentDirection: 'inbound' },
    { kind: 'tool', agentDirection: 'outbound' },
    { kind: 'tool', agentDirection: 'inbound', agentResponseKey: 'old', agentResponseHasBody: false },
  ]) {
    assert.equal(appendAgentResponseTail(previous, response, 789), null);
  }
});

test('empty raw results remain null and non-boolean flags do not become true', () => {
  const patch = appendAgentResponseTail(
    { kind: 'tool', agentDirection: 'inbound', agentResponseHasBody: false },
    { rawResult: null, raw: ' \n ', hasBody: 'true', isError: 'true' },
    789
  );
  assert.equal(patch.rawResult, null);
  assert.equal(patch.count, 2);
  assert.equal(patch.agentResponseHasBody, false);
  assert.equal(patch.isError, false);
  assert.deepEqual(patch.agentResponseKeys, []);
});
