import test from 'node:test';
import assert from 'node:assert/strict';

import { projectSettledTranscriptRows } from './transcript-rows.ts';

function project(text) {
  return projectSettledTranscriptRows({
    sessionKey: 'session',
    items: [{ kind: 'user', id: text, text }],
    turnKeys: ['turn'],
    failedTurns: new Set(),
  }).rows;
}

test('restart and implicit interruption markers become Cancelled status rows', () => {
  for (const marker of [
    '[Request interrupted by process restart]',
    '[Request interrupted]',
  ]) {
    const rows = project(marker);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._tag, 'AssistantPart');
    assert.equal(rows[0].item.kind, 'turndone');
    assert.equal(rows[0].item.status, 'cancelled');
    assert.equal(rows[0].item.elapsedMs, 0);
  }
});

test('similar human prose remains a user message', () => {
  const rows = project('Please explain [Request interrupted]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'UserMessage');
});

test('failed turn rows preserve the terminal reason for the retry card', () => {
  const rows = projectSettledTranscriptRows({
    sessionKey: 'session',
    items: [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'turndone', id: 'd1', status: 'failed', detail: 'Provider is busy at capacity.' },
    ],
    turnKeys: ['turn', 'turn'],
    failedTurns: new Set(['turn']),
  }).rows;
  assert.equal(rows.at(-1)._tag, 'Error');
  assert.equal(rows.at(-1).item.detail, 'Provider is busy at capacity.');
});
