import assert from "node:assert/strict";
import { setImmediate as waitForTurn } from "node:timers/promises";
import { test } from "node:test";

test("project file-change subscriptions share one recursive watcher", async () => {
  const originalWindow = globalThis.window;
  const starts = [];
  const stops = [];
  let receive = () => {};
  globalThis.window = {
    mixdogDesktop: {
      folderWatch: async (path, recursive) => { starts.push([path, recursive]); },
      folderUnwatch: async (path, recursive) => { stops.push([path, recursive]); },
      subscribeFolderChanges: (listener) => {
        receive = listener;
        return () => { receive = () => {}; };
      },
    },
  };

  try {
    const { subscribeProjectFileChanges } = await import("./project-file-changes.ts");
    let first = 0;
    let second = 0;
    const releaseFirst = subscribeProjectFileChanges("C:\\Project\\mixdog", () => { first += 1; });
    const releaseSecond = subscribeProjectFileChanges("C:\\Project\\mixdog\\", () => { second += 1; });
    await waitForTurn();
    assert.deepEqual(starts, [["C:\\Project\\mixdog", true]]);

    // Case folding is a Windows path rule; posix keys are exact, so the echoed
    // change keeps the subscribed spelling there.
    receive(navigator.platform.toLowerCase().includes("win") ? "c:\\project\\mixdog" : "C:\\Project\\mixdog");
    assert.equal(first, 1);
    assert.equal(second, 1);

    releaseFirst();
    await waitForTurn();
    assert.deepEqual(stops, []);
    releaseSecond();
    await waitForTurn();
    assert.deepEqual(stops, [["C:\\Project\\mixdog", true]]);
  } finally {
    globalThis.window = originalWindow;
  }
});
