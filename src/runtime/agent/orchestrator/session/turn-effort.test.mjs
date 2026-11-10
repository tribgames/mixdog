import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTurnEffort } from './turn-effort.mjs';

const mark = (effort) => ({ meta: { effortConfiguration: { effort } } });

test('currentTurnEffort reads the newest mark of the turn in flight', () => {
  const session = {
    messages: [],
    liveTurnMessages: [
      { role: 'user', content: 'old', ...mark('high') },
      { role: 'tool', ...mark('xhigh') },
      { role: 'user', content: 'now', ...mark('medium') },
      { role: 'assistant', content: '' },
      { role: 'tool' },
    ],
  };
  assert.equal(currentTurnEffort(session), 'medium');
  session.liveTurnMessages.push({ role: 'tool', ...mark('low') });
  assert.equal(currentTurnEffort(session), 'low', 'a step re-judge replaces the turn value');
});

test('currentTurnEffort is null without a mark in the current turn, and falls back to messages', () => {
  assert.equal(currentTurnEffort({ messages: [{ role: 'user' }, { role: 'tool', ...mark('high') }] }), 'high');
  assert.equal(
    currentTurnEffort({ liveTurnMessages: [{ role: 'tool', ...mark('high') }, { role: 'user' }, { role: 'tool' }] }),
    null
  );
  assert.equal(currentTurnEffort(null), null);
});
