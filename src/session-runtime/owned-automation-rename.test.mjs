import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginAutomationRename, runOwnedAutomation } from './owned-automation-run.mjs';

// The owner check waits until the test lets it go; `asked` resolves once it is reached.
function heldOwnerCheck() {
  const asked = Promise.withResolvers();
  const answer = Promise.withResolvers();
  return {
    asked: asked.promise,
    answer: (problem) => answer.resolve(problem),
    ownerProblem: () => {
      asked.resolve();
      return answer.promise;
    },
  };
}

function start(active, owner, runs) {
  return runOwnedAutomation(
    'schedule',
    { name: 'a', ownerAgentId: 'reviewer' },
    async () => {
      runs.push('a');
      return { sessionId: 's', result: 'ok' };
    },
    { active, attended: true, ownerProblem: owner.ownerProblem, log() {} }
  );
}

test('a rename while a run waits for its owner check is refused, and the run goes on', async () => {
  const active = new Set();
  const owner = heldOwnerCheck();
  const runs = [];
  const run = start(active, owner, runs);
  await owner.asked;
  assert.equal(beginAutomationRename('schedule', 'a', active), null, 'the waiting run holds the name');
  owner.answer('');
  assert.equal((await run).result, 'ok');
  assert.deepEqual(runs, ['a']);
  assert.equal(active.size, 0, 'released once the run settles');
});

test('a run that found a rename reserving its name is skipped, even when the rename ends during its owner check', async () => {
  const active = new Set();
  const owner = heldOwnerCheck();
  const runs = [];
  const release = beginAutomationRename('schedule', 'a', active);
  const run = start(active, owner, runs);
  await owner.asked;
  release();
  owner.answer('');
  assert.equal((await run).reason, 'overlap');
  assert.deepEqual(runs, [], 'nothing runs under the old name');
  assert.equal(active.size, 0);
});

test('an owner problem still wins over an overlap, and leaves the other run its reservation', async () => {
  const active = new Set(['schedule:a']);
  const owner = heldOwnerCheck();
  const run = start(active, owner, []);
  owner.answer('owner-deleted');
  const outcome = await run;
  assert.equal(outcome.reason, 'owner');
  assert.deepEqual([...active], ['schedule:a']);
});
