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
    ['resume', 'pause', 'signal', 'dispose'].map((name) => [name, () => calls.push(name)])
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
    assert.deepEqual(calls, ['resume', 'signal', 'pause', 'resume'], 'focus is no evidence');
    stop();
    windowTarget.dispatchEvent(new Event('mixdog:git-changed'));
    windowTarget.dispatchEvent(new Event('focus'));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(calls, ['resume', 'signal', 'pause', 'resume', 'dispose']);
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
    ['resume', 'pause', 'signal', 'dispose'].map((name) => [name, () => calls.push(name)])
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

// The installed build re-read every mounted watcher in full on any repository's push and on every focus (243 review/diff/get
// and 179 git/status calls over 1 s). A watcher reads only on evidence that names its own project.
test('a watcher re-reads only on evidence that names its own project', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'visible';
  const pushes = new Set();
  const fsListeners = new Set();
  const watches = [];
  let revision = 0;
  windowTarget.mixdogDesktop = {
    sections: {
      core: async () => true,
      snapshot: async () => ({ status: 'ready', entries: [] }),
      subscribe(listener) {
        pushes.add(listener);
        return () => pushes.delete(listener);
      },
      subscribeFsChanged(listener) {
        fsListeners.add(listener);
        return () => fsListeners.delete(listener);
      },
      call: async (method, params) => {
        if (method === 'fs/watch') watches.push(params);
      },
    },
  };
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;
  const push = async (section, key) => {
    revision += 1;
    const entry = { section, key, revision, value: section === 'gitStatus' ? { root: key } : {} };
    for (const listener of [...pushes]) listener({ kind: 'sections', changes: [{ section, key, entry }] });
    await waitForDelay(5);
  };
  const fsChange = async (watchId) => {
    for (const listener of [...fsListeners]) listener({ watchId, changedPaths: [], kind: 'modified' });
    await waitForDelay(5);
  };
  let reads = 0;
  try {
    const stop = watchGitRefreshEvidence(
      'C:/work/repo/app',
      createGitRefreshScheduler(
        async () => {
          reads += 1;
        },
        // Which evidence reads is under test here, not the gap between reads.
        { activityMinGapMs: 0 }
      )
    );
    await waitForDelay(5);
    assert.equal(reads, 1, 'the first read');
    assert.equal(watches.length, 1, 'the project folder is watched');

    // What used to re-read every watcher: another repository's status, the key-less review tell, window focus.
    for (let round = 0; round < 3; round += 1) {
      await push('gitStatus', 'C:/work/other');
      await push('reviewDiff', null);
      windowTarget.dispatchEvent(new Event('focus'));
      await fsChange('another-watch');
    }
    assert.equal(reads, 1, 'nothing about this project: no read (was 10)');

    await push('gitStatus', 'C:/work/repo');
    assert.equal(reads, 2, "the project's own repository status");
    await fsChange(watches[0].watchId);
    assert.equal(reads, 3, 'a change under the project folder');

    // Coming back into view reads only when evidence arrived meanwhile.
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await waitForDelay(5);
    assert.equal(reads, 3, 'no change while hidden: no read');
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await fsChange(watches[0].watchId);
    assert.equal(reads, 3, 'paused while hidden');
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await waitForDelay(5);
    assert.equal(reads, 4, 'the change seen while hidden is read on return');
    stop();
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

test('runs in a burst wait out the minimum gap, and evidence meanwhile leaves one run', async () => {
  let runs = 0;
  const scheduler = createGitRefreshScheduler(
    async () => {
      runs += 1;
    },
    { activityMinGapMs: 120 }
  );
  scheduler.resume();
  await waitForDelay(10);
  assert.equal(runs, 1, 'the first run is not held');
  // Occasional evidence reads at once.
  scheduler.signal();
  await waitForDelay(10);
  scheduler.signal();
  await waitForDelay(10);
  assert.equal(runs, 3, 'runs that are not yet a burst start at once');
  // Three runs ended within the burst window: the next waits out the gap, and evidence meanwhile is one run.
  scheduler.signal();
  scheduler.signal();
  scheduler.signal();
  await waitForDelay(40);
  assert.equal(runs, 3, 'a burst holds the next run for the gap');
  await waitForDelay(150);
  assert.equal(runs, 4, 'the held evidence is one run once the gap passes');
  await waitForDelay(150);
  assert.equal(runs, 4, 'no evidence, no run');
  scheduler.dispose();
});
