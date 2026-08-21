import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLiveTranscriptRows,
  projectSettledTranscriptRows,
} from './transcript-rows.ts';

function project(items, turnKeys = items.map(() => 'turn')) {
  return projectSettledTranscriptRows({
    sessionKey: 'session',
    items,
    turnKeys,
    failedTurns: new Set(),
  });
}

test('groups consecutive mixed-category tools into one activity row', () => {
  const shell = { kind: 'tool', id: 'shell', name: 'shell', result: 'ok' };
  const search = { kind: 'tool', id: 'search', name: 'grep', result: 'ok' };
  const rows = project([shell, search]).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'ToolActivity');
  assert.deepEqual(rows[0].items, [shell, search]);
});

test('a visible assistant message seals the current tool activity run', () => {
  const first = { kind: 'tool', id: 'first', name: 'read', result: 'ok' };
  const message = { kind: 'assistant', id: 'message', text: 'Next check.' };
  const second = { kind: 'tool', id: 'second', name: 'shell', result: 'ok' };
  const rows = project([first, message, second]).rows;

  assert.deepEqual(rows.map((row) => row._tag), [
    'ToolActivity',
    'AssistantPart',
    'ToolActivity',
  ]);
  assert.deepEqual(rows[0].items, [first]);
  assert.deepEqual(rows[2].items, [second]);
});

test('thinking remains a separate row after grouped tool activity', () => {
  const settled = project([
    { kind: 'tool', id: 'tool', name: 'shell', result: 'ok' },
  ]);
  const rows = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled,
    thinking: true,
  });

  assert.deepEqual(rows.map((row) => row._tag), ['ToolActivity', 'Thinking']);
});
