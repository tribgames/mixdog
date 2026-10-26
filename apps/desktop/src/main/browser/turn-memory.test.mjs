import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnMemory } from './turn-memory.ts';

test('a turn memory remembers without a count cap and drops by turn or session', () => {
  const memory = createTurnMemory();
  for (let key = 0; key < 1000; key += 1) assert.equal(memory.add('s', 1, `k${key}`), true);
  assert.equal(memory.add('s', 1, 'k0'), false, 'the first of a thousand is still remembered');
  assert.equal(memory.has('s', 1, 'k0'), true);
  memory.add('s', 2, 'a');
  memory.add('s', 3, 'a');
  memory.add('t', 1, 'a');
  memory.finishTurn('s', 2);
  assert.equal(memory.has('s', 1, 'k0'), false);
  assert.equal(memory.has('s', 2, 'a'), false, 'the finished turn and the earlier ones go');
  assert.equal(memory.has('s', 3, 'a'), true, 'a later turn stays');
  assert.equal(memory.has('t', 1, 'a'), true, 'another session stays');
  memory.forgetSession('s');
  memory.finishTurn('t', 1);
  assert.equal(memory.sessions(), 0, 'nothing is left behind');
});
