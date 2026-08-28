import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginComputerOperation,
  withHumanOnlyApproval,
} from './human-only-approval';

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
  assert.throws(
    () => beginComputerOperation(),
    /human-only approval is pending/,
  );

  releaseComputer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(enteredApproval, true);
  assert.throws(
    () => beginComputerOperation(),
    /human-only approval is pending/,
  );

  finishApproval();
  assert.equal(await approval, 'approved');
  const releaseAfterApproval = beginComputerOperation();
  releaseAfterApproval();
});
