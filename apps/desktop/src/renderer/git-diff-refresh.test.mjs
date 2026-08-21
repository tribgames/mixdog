import assert from "node:assert/strict";
import { setImmediate as waitForTurn } from "node:timers/promises";
import { test } from "node:test";

import { createSingleFlightRefresh } from "./git-diff-refresh.ts";

test("diff refreshes stay single-flight and coalesce pressure into one follow-up", async () => {
  const releases = [];
  let active = 0;
  let maxActive = 0;
  let starts = 0;
  const queue = createSingleFlightRefresh(async () => {
    starts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
  });

  const completion = queue.request();
  assert.strictEqual(queue.request(), completion);
  assert.strictEqual(queue.request(), completion);
  assert.equal(starts, 1);

  releases.shift()();
  await waitForTurn();
  assert.equal(starts, 2);
  assert.equal(maxActive, 1);

  releases.shift()();
  await completion;
  assert.equal(starts, 2);
  assert.equal(maxActive, 1);
});
