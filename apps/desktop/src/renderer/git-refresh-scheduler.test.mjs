import assert from "node:assert/strict";
import { setImmediate as waitForTurn, setTimeout as waitForDelay } from "node:timers/promises";
import { test } from "node:test";

import { createGitRefreshScheduler } from "./git-refresh-scheduler.ts";
import { prewarmUtilityDockGitState } from "./UtilityDock.tsx";

test("git refresh scheduler stays single-flight and keeps one trailing activity run", async () => {
  const releases = [];
  const reasons = [];
  const scheduler = createGitRefreshScheduler(
    (reason) => new Promise((resolve) => {
      reasons.push(reason);
      releases.push(resolve);
    }),
    {
      safetyIntervalMs: 60_000,
      activityDebounceMs: 0,
      activityMinGapMs: 0,
    },
  );

  scheduler.resume();
  await waitForTurn();
  assert.deepEqual(reasons, ["activity"]);
  scheduler.signal();
  scheduler.signal();
  assert.equal(reasons.length, 1);

  releases.shift()();
  await waitForDelay(20);
  assert.deepEqual(reasons, ["activity", "activity"]);

  releases.shift()();
  await waitForTurn();
  scheduler.dispose();
});

test("utility dock prewarm fills one reusable fast Git cache entry", async () => {
  const projectPath = "C:/utility-dock-prewarm";
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    ...previousWindow,
    mixdogDesktop: {
      gitStatus: async (project, options) => {
        calls.push({ project, options });
        await waitForTurn();
        return null;
      },
    },
  };
  try {
    await Promise.all([
      prewarmUtilityDockGitState(projectPath),
      prewarmUtilityDockGitState(projectPath),
    ]);
    await prewarmUtilityDockGitState(projectPath);
    assert.deepEqual(calls, [{
      project: projectPath,
      options: { skipLineStats: true },
    }]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
