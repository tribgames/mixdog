import assert from "node:assert/strict";
import test from "node:test";
import { startVisibleRefreshCadence } from "./visible-refresh-cadence.ts";
import { createRendererClock } from "../../scripts/test-renderer-clock.mjs";

test("hidden documents own no polling timer and resume exactly once", async () => {
  const clock = createRendererClock("hidden");
  const calls = [];
  const stop = startVisibleRefreshCadence({
    win: clock.win, intervalMs: 4_000, refresh: (reason) => calls.push(reason),
  });
  await clock.advance(60_000);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(calls, []);
  clock.visibility("visible");
  clock.win.emit("pageshow");
  clock.win.emit("focus");
  assert.deepEqual(calls, ["visible"]);
  await clock.advance(4_000);
  assert.deepEqual(calls, ["visible", "interval"]);
  const stale = [...clock.timers.values()][0].callback;
  clock.visibility("hidden");
  clock.visibility("visible");
  stale();
  assert.deepEqual(calls, ["visible", "interval", "visible"]);
  stop();
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});

test("page suspension and repeated setup/teardown leave no owned resources", async () => {
  const clock = createRendererClock();
  let calls = 0;
  for (let index = 0; index < 2_000; index += 1) {
    const stop = startVisibleRefreshCadence({
      win: clock.win, intervalMs: 4_000, refresh: () => { calls += 1; },
    });
    clock.win.emit("pagehide");
    assert.equal(clock.timers.size, 0);
    clock.win.emit("pageshow");
    stop();
    stop();
  }
  const settledCalls = calls;
  await clock.advance(60_000);
  clock.visibility("visible");
  assert.equal(calls, settledCalls);
  assert.equal(clock.timers.size + clock.doc.listenerCount() + clock.win.listenerCount(), 0);
});
