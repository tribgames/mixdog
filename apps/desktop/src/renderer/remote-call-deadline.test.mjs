import assert from "node:assert/strict";
import test from "node:test";
import { armRemoteCallDeadline } from "./remote-call-deadline.ts";

test("one expired call fails once, probes liveness, and leaves sibling calls pending", () => {
  const pending = new Map([[1, {}], [2, {}]]);
  const failures = [];
  let probes = 0, expire, delay;
  armRemoteCallDeadline(pending, 1, (error) => failures.push(error), () => { probes += 1; }, {
    setTimeout: (callback, ms) => { expire = callback; delay = ms; return 1; },
  });
  assert.equal(delay, 20_000);
  expire();
  expire();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, "mixdog remote call timed out.");
  assert.equal(probes, 1);
  assert.equal(pending.has(2), true);
});

test("a call already settled never fails again or probes the connection", () => {
  const pending = new Map([[1, {}]]);
  let expire, effects = 0;
  armRemoteCallDeadline(pending, 1, () => { effects += 1; }, () => { effects += 1; }, {
    setTimeout: (callback) => { expire = callback; return 1; },
  });
  pending.delete(1);
  expire();
  assert.equal(effects, 0);
});
