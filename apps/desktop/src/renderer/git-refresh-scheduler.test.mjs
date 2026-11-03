import assert from 'node:assert/strict';
import { setImmediate as waitForTurn, setTimeout as waitForDelay } from 'node:timers/promises';
import { test } from 'node:test';

import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler.ts';
import { prewarmUtilityDockGitState } from './UtilityDock.tsx';

test('git refresh scheduler stays single-flight and keeps one trailing activity run', async () => {
  const releases = [];
  let runs = 0;
  const scheduler = createGitRefreshScheduler(
    () =>
      new Promise((resolve) => {
        runs += 1;
        releases.push(resolve);
      }),
    {
      activityDebounceMs: 0,
      activityMinGapMs: 0,
    }
  );

  scheduler.resume();
  await waitForTurn();
  assert.equal(runs, 1);
  scheduler.signal();
  scheduler.signal();
  assert.equal(runs, 1);

  releases.shift()();
  // The trailing run waits out the first run's own duration, which a loaded CI host stretches.
  const deadline = Date.now() + 2_000;
  while (runs < 2 && Date.now() < deadline) await waitForDelay(5);
  assert.equal(runs, 2);

  releases.shift()();
  // No event, no run: nothing re-reads on a clock.
  await waitForDelay(50);
  assert.equal(runs, 2);
  scheduler.dispose();
});

test('git refresh evidence drives the scheduler until its teardown disposes it', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'visible';
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;
  const calls = [];
  const scheduler = Object.fromEntries(
    ['resume', 'pause', 'signal', 'refreshNow', 'dispose'].map((name) => [name, () => calls.push(name)])
  );
  try {
    const stop = watchGitRefreshEvidence('C:/git-refresh-evidence', scheduler);
    assert.deepEqual(calls, ['resume']);
    windowTarget.dispatchEvent(new Event('mixdog:git-changed'));
    windowTarget.dispatchEvent(new Event('focus'));
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(calls, ['resume', 'signal', 'refreshNow', 'pause', 'resume']);
    stop();
    windowTarget.dispatchEvent(new Event('mixdog:git-changed'));
    windowTarget.dispatchEvent(new Event('focus'));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(calls, ['resume', 'signal', 'refreshNow', 'pause', 'resume', 'dispose']);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('a hidden document leaves the watched scheduler paused until it becomes visible', () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'hidden';
  globalThis.window = new EventTarget();
  globalThis.document = documentTarget;
  const calls = [];
  const scheduler = Object.fromEntries(
    ['resume', 'pause', 'signal', 'refreshNow', 'dispose'].map((name) => [name, () => calls.push(name)])
  );
  try {
    const stop = watchGitRefreshEvidence('C:/git-refresh-evidence', scheduler);
    assert.deepEqual(calls, []);
    stop();
    assert.deepEqual(calls, ['dispose']);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('utility dock prewarm fills one reusable fast Git cache entry', async () => {
  const projectPath = 'C:/utility-dock-prewarm';
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
    await Promise.all([prewarmUtilityDockGitState(projectPath), prewarmUtilityDockGitState(projectPath)]);
    await prewarmUtilityDockGitState(projectPath);
    assert.deepEqual(calls, [
      {
        project: projectPath,
        options: { skipLineStats: true },
      },
    ]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
