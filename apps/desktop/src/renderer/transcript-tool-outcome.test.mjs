import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';
import { flattenedToolActivityItems, toolCallOutcome } from './transcript-tool-core.ts';

// A stored tool call as the core sends it: the run states its result, when a record stores one.
const stored = (status, run = {}) => ({
  type: 'toolCall',
  id: 'a1',
  name: 'shell',
  input: { command: 'ls' },
  run: { callId: 'c1', count: 1, completedCount: 1, ...run },
  meta: { status, at: 1000 },
});

test('a stored call that ended with its turn and has no result is stopped, never done', () => {
  assert.deepEqual(toolCallOutcome(rowOf(stored('interrupted'))), { state: 'stopped', tone: 'warning' });
});

test('an aggregate card with a stopped member is stopped, and its members read as they ended', () => {
  const member = (id, status, run) => ({ ...stored(status, run), id, name: 'read', input: { path: id } });
  const [card] = mergeToolRows([rowOf(member('a', 'completed', { result: 'one' })), rowOf(member('b', 'interrupted'))]);
  assert.equal(card.name, '__aggregate__');
  assert.deepEqual(toolCallOutcome(card), { state: 'stopped', tone: 'warning' });
  assert.deepEqual(
    flattenedToolActivityItems([card]).map((item) => toolCallOutcome(item).state),
    ['done', 'stopped']
  );
});

test('a stored call with a result is done, an empty one too; a call still open is running', () => {
  assert.deepEqual(toolCallOutcome(rowOf(stored('completed', { result: 'a.txt' }))), { state: 'done', tone: 'neutral' });
  assert.deepEqual(toolCallOutcome(rowOf(stored('completed', { result: '' }))), { state: 'done', tone: 'neutral' });
  assert.deepEqual(toolCallOutcome(rowOf({ ...stored(undefined, { completedCount: 0 }), meta: { at: 1000 } })), {
    state: 'running',
    tone: 'neutral',
  });
});
