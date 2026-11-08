import assert from 'node:assert/strict';
import { setImmediate as waitForTurn } from 'node:timers/promises';
import { test } from 'node:test';

test('project file-change subscriptions share one recursive watcher', async () => {
  const originalWindow = globalThis.window;
  const starts = [];
  const stops = [];
  let receive = () => {};
  globalThis.window = {
    mixdogDesktop: {
      folderWatch: async (path, recursive) => {
        starts.push([path, recursive]);
      },
      folderUnwatch: async (path, recursive) => {
        stops.push([path, recursive]);
      },
      subscribeFolderChanges: (listener) => {
        receive = listener;
        return () => {
          receive = () => {};
        };
      },
    },
  };

  try {
    const { subscribeProjectFileChanges } = await import('./project-file-changes.ts');
    let first = 0;
    let second = 0;
    const releaseFirst = subscribeProjectFileChanges('C:\\Project\\mixdog', () => {
      first += 1;
    });
    const releaseSecond = subscribeProjectFileChanges('C:\\Project\\mixdog\\', () => {
      second += 1;
    });
    await waitForTurn();
    assert.deepEqual(starts, [['C:\\Project\\mixdog', true]]);

    // Case folding is a Windows path rule; posix keys are exact, so the echoed
    // change keeps the subscribed spelling there.
    receive(navigator.platform.toLowerCase().includes('win') ? 'c:\\project\\mixdog' : 'C:\\Project\\mixdog');
    assert.equal(first, 1);
    assert.equal(second, 1);

    releaseFirst();
    await waitForTurn();
    assert.deepEqual(stops, []);
    releaseSecond();
    await waitForTurn();
    assert.deepEqual(stops, [['C:\\Project\\mixdog', true]]);
  } finally {
    globalThis.window = originalWindow;
  }
});

// A window on a core connection has no Node folder watcher: `folderWatch` is not an operation the core carries, so the
// project watch is the core's `fs/watch` (one watch id per project, shared by its subscribers) and a change is the
// `fs/changed` of that watch id.
test('on a core connection project file-change subscriptions share one fs/watch and follow its fs/changed', async () => {
  const originalWindow = globalThis.window;
  const calls = [];
  let push = () => {};
  globalThis.window = {
    mixdogDesktop: {
      folderWatch: async () => assert.fail('the Node folder watcher is not used on a core connection'),
      folderUnwatch: async () => assert.fail('the Node folder watcher is not used on a core connection'),
      subscribeFolderChanges: () => assert.fail('the Node folder watcher is not used on a core connection'),
      sections: {
        core: async () => true,
        call: async (method, params) => {
          calls.push([method, params]);
        },
        subscribeFsChanged: (listener) => {
          push = listener;
          return () => {
            push = () => {};
          };
        },
      },
    },
  };

  try {
    const { subscribeProjectFileChanges } = await import('./project-file-changes.ts');
    let first = 0;
    let second = 0;
    const releaseFirst = subscribeProjectFileChanges('/work/core-project', () => (first += 1));
    const releaseSecond = subscribeProjectFileChanges('/work/core-project/', () => (second += 1));
    await waitForTurn();
    assert.equal(calls.length, 1);
    const [method, params] = calls[0];
    assert.equal(method, 'fs/watch');
    assert.deepEqual({ path: params.path, recursive: params.recursive }, { path: '/work/core-project', recursive: true });

    push({ watchId: 'someone-else', changedPaths: ['/x'], kind: 'modified' });
    assert.deepEqual([first, second], [0, 0]);
    push({ watchId: params.watchId, changedPaths: ['/work/core-project/a.ts'], kind: 'modified' });
    assert.deepEqual([first, second], [1, 1]);

    releaseFirst();
    await waitForTurn();
    assert.equal(calls.length, 1);
    releaseSecond();
    await waitForTurn();
    assert.deepEqual(calls[1], ['fs/unwatch', { watchId: params.watchId }]);
    push({ watchId: params.watchId, changedPaths: [], kind: 'modified' });
    assert.deepEqual([first, second], [1, 1], 'a released watch is no longer followed');
  } finally {
    globalThis.window = originalWindow;
  }
});
