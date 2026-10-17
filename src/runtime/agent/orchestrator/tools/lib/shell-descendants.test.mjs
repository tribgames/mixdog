import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './process-table-fixture.mjs';

const tree = scriptedChildTree();
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { createProcessTreeTracker, killShellDescendants, probeShellDescendants, waitForShellDescendants } = await import(
  './shell-descendants.mjs'
);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ROOT = 5100;

test('a pre-kill capture keeps a grandchild whose parent link broke', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () =>
    processTable([{ pid: ROOT }, { pid: 5101, ppid: ROOT }, { pid: 5102, ppid: 5101, token: 'grandchild' }]);
  assert.equal(await tracker.capture(), true);
  tree.state.next = () => processTable([{ pid: 5102, ppid: 5101, token: 'grandchild' }]);
  assert.equal(await tracker.observe({ rootExited: true }), 'running');
  assert.deepEqual(
    tracker.live.map((entry) => entry.pid),
    [5102]
  );
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: true }), 'gone');
});

test('without a pre-exit capture the observation stays unknown, never empty', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await assert.rejects(tracker.capture());
  await assert.rejects(tracker.observe({ rootExited: true }));
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: true }), 'unknown', 'an empty table after the kill proves nothing');
  assert.equal(await tracker.observe({ rootExited: true }), 'unknown');
});

// POSIX first consults the real kernel for the (fake) group, so the scripted
// table is only reached on Windows.
test('the post-exit probe compares identities, not pids', { skip: process.platform !== 'win32' }, async () => {
  tree.state.next = () =>
    processTable([
      { pid: ROOT, token: 'reused-root' },
      { pid: process.pid, ppid: ROOT, token: 'child-of-the-reuse' },
    ]);
  assert.equal(await probeShellDescendants({ pid: ROOT }), null);
  tree.state.next = () => processTable([{ pid: process.pid, ppid: ROOT, token: 'orphan' }]);
  const handle = await probeShellDescendants({ pid: ROOT });
  assert.deepEqual(handle.watch, [{ pid: process.pid, token: 'orphan', name: 'node.exe' }]);
});

test('a survivor whose pid was recycled ends the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handle = {
    rootPid: ROOT,
    groupPid: null,
    killPids: [process.pid],
    watchPids: [process.pid],
    watch: [{ pid: process.pid, token: 'survivor', name: 'node.exe' }],
  };
  tree.state.next = () => processTable([{ pid: process.pid, ppid: 1, token: 'survivor' }]);
  let done = false;
  const waiting = waitForShellDescendants(handle).then((value) => {
    done = value;
  });
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(done, false);
  tree.state.next = () => processTable([{ pid: process.pid, ppid: 1, token: 'recycled' }]);
  t.mock.timers.tick(5_000);
  await waiting;
  assert.equal(done, true);
});

test('a recycled pid is never a kill target', async () => {
  tree.state.kills.length = 0;
  tree.state.next = () => processTable([{ pid: 5200, token: 'someone-else' }]);
  const outcome = await killShellDescendants({
    rootPid: ROOT,
    groupPid: null,
    killPids: [5200],
    watchPids: [5200],
    watch: [{ pid: 5200, token: 'survivor', name: 'node.exe' }],
  });
  assert.deepEqual(tree.state.kills, []);
  assert.equal(outcome.terminated, true);
});
