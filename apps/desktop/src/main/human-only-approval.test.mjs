import assert from 'node:assert/strict';
import test from 'node:test';

import { beginComputerOperation, withHumanOnlyApproval } from './human-only-approval';

test('human-only approval waits for active Computer Use and blocks new Computer Use', async () => {
  const releaseComputer = beginComputerOperation();
  let enteredApproval = false;
  let finishApproval;
  const approvalFinished = new Promise((resolve) => {
    finishApproval = resolve;
  });
  const approval = withHumanOnlyApproval(async () => {
    enteredApproval = true;
    await approvalFinished;
    return 'approved';
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(enteredApproval, false);
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/);

  releaseComputer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(enteredApproval, true);
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/);

  finishApproval();
  assert.equal(await approval, 'approved');
  const releaseAfterApproval = beginComputerOperation();
  releaseAfterApproval();
});

test('an approval waiting its turn for the lock gives it up when stopped, without blocking later ones', async () => {
  const releaseComputer = beginComputerOperation();
  const controller = new AbortController();
  let entered = false;
  const stopped = withHumanOnlyApproval(async () => {
    entered = true;
    return 'never';
  }, controller.signal);
  const rejected = assert.rejects(stopped, /stopped waiting/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error('stopped waiting'));
  await rejected;
  assert.equal(entered, false, 'a stopped approval never opens');

  // The aborted waiter no longer blocks Computer Use, and a later approval runs.
  beginComputerOperation()();
  releaseComputer();
  assert.equal(await withHumanOnlyApproval(async () => 'next'), 'next');
  beginComputerOperation()();

  // Already-aborted: it does not even queue.
  const early = new AbortController();
  early.abort(new Error('already stopped'));
  await assert.rejects(
    withHumanOnlyApproval(async () => 'never', early.signal),
    /already stopped/
  );
  beginComputerOperation()();
});
