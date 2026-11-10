import assert from 'node:assert/strict';
import test from 'node:test';

import { agentMaintenanceSettled, registerAgentMaintenance, runAgentMaintenancePass } from './maintenance-pass.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a deadline crossed while a pass runs starts the next pass at once', async (t) => {
  const deadline = Date.now() + 30;
  let passes = 0;
  let handled = false;
  const unregister = registerAgentMaintenance(
    () => [
      () => {
        passes += 1;
        if (Date.now() >= deadline) {
          handled = true;
          return;
        }
        // This step looks before the deadline and finishes after it.
        while (Date.now() <= deadline + 5) {}
      },
    ],
    (since) => (handled ? Infinity : deadline > since ? deadline : Infinity)
  );
  t.after(unregister);
  await runAgentMaintenancePass();
  await pause(50);
  await agentMaintenanceSettled();
  assert.equal(passes, 2);
  assert.equal(handled, true, 'the work that came due mid-pass was done');
});

test('a deadline the pass already looked at does not run it again', async (t) => {
  // Due before the pass began, and still standing after it (held by live
  // work): only the event that ends that work runs a pass.
  const deadline = Date.now() - 1_000;
  let passes = 0;
  const unregister = registerAgentMaintenance(
    () => [() => (passes += 1)],
    (since) => (deadline > since ? deadline : Infinity)
  );
  t.after(unregister);
  await runAgentMaintenancePass();
  await pause(100);
  await agentMaintenanceSettled();
  assert.equal(passes, 1);
});
