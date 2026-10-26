import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnMemory } from './turn-memory.ts';

test('a turn memory remembers without a count cap and drops by turn or session', () => {
  const memory = createTurnMemory();
  const first = memory.turn('s', 1);
  for (let key = 0; key < 1000; key += 1) assert.equal(first.add(`k${key}`), true);
  assert.equal(first.add('k0'), false, 'the first of a thousand is still remembered');
  assert.equal(memory.turn('s', 1).has('k0'), true);
  memory.turn('s', 2).add('a');
  memory.turn('s', 3).add('a');
  memory.turn('t', 1).add('a');
  memory.finishTurn('s', 2);
  assert.equal(memory.turn('s', 1).has('k0'), false);
  assert.equal(memory.turn('s', 2).has('a'), false, 'the finished turn and the earlier ones go');
  assert.equal(memory.turn('s', 3).has('a'), true, 'a later turn stays');
  assert.equal(memory.turn('t', 1).has('a'), true, 'another session stays');
  memory.forgetSession('s');
  memory.finishTurn('t', 1);
  assert.equal(memory.sessions(), 0, 'nothing is left behind');
});

test('a write after the session was released or the turn finished is ignored, and a new turn starts empty', () => {
  const memory = createTurnMemory();
  const released = memory.turn('s', 1);
  memory.forgetSession('s');
  assert.equal(released.add('late'), false, 'the released session takes no write');
  assert.equal(memory.sessions(), 0, 'and nothing is brought back');
  const again = memory.turn('s', 1);
  assert.equal(again.has('late'), false);
  assert.equal(again.add('now'), true, 'the same session and turn id begin again');
  assert.equal(released.add('later'), false, 'the old claim stays dead');

  const finished = memory.turn('s', 2);
  memory.finishTurn('s', 2);
  assert.equal(finished.add('late'), false, 'a finished turn takes no write');
  assert.equal(memory.turn('s', 3).add('next'), true, 'a later turn works');
  memory.forgetSession('s');
  assert.equal(memory.sessions(), 0);
});
