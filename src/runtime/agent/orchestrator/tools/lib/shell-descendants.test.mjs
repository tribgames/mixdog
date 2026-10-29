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

// Windows: a process keeps its dead parent's pid as its parent link, and the
// pid is soon handed to a new process. Only a process created after the one
// its link names can be its child. Tokens are kernel FILETIME ticks (100 ns),
// as the table reports them at microsecond precision.
const T0 = 134_062_416_010_000_000n;
const filetime = (ticks) => String(T0 + BigInt(ticks));
const older = { pid: 5101, ppid: ROOT, token: filetime(-1_000_000) };
const consoleHost = { pid: 5102, ppid: ROOT, token: filetime(130_000), name: 'conhost.exe' };

test(
  'a root that exited before any read still tells its children from older processes by its spawn creation time',
  { skip: process.platform !== 'win32' },
  async () => {
    const rootCreationTime = filetime(0);
    tree.state.next = () => processTable([older]);
    assert.equal(await probeShellDescendants({ pid: ROOT, rootCreationTime }), null);
    tree.state.next = () => processTable([older, consoleHost]);
    const handle = await probeShellDescendants({ pid: ROOT, rootCreationTime });
    assert.deepEqual(handle.watchPids, [5102]);
    // The survivors' own watch keeps that time.
    tree.state.next = () => processTable([older]);
    assert.equal(await waitForShellDescendants(handle), true);
  }
);

test(
  'a real child and grandchild created milliseconds after the root stay kill targets',
  { skip: process.platform !== 'win32' },
  async () => {
    tree.state.next = () =>
      processTable([
        { pid: 5101, ppid: ROOT, token: filetime(10_000) },
        { pid: 5102, ppid: 5101, token: filetime(20_000) },
      ]);
    const handle = await probeShellDescendants({ pid: ROOT, rootCreationTime: filetime(0) });
    assert.deepEqual(handle.killPids, [5101, 5102]);
  }
);

test('creation order is decided below the millisecond', { skip: process.platform !== 'win32' }, async () => {
  // Root at +4.5 us; the table truncates to whole microseconds, so a child
  // created 0.3 us after the root shows +4 us and an older process +2 us.
  tree.state.next = () =>
    processTable([
      { pid: 5101, ppid: ROOT, token: filetime(20) },
      { pid: 5102, ppid: ROOT, token: filetime(40) },
    ]);
  const handle = await probeShellDescendants({ pid: ROOT, rootCreationTime: filetime(45) });
  assert.deepEqual(handle.killPids, [5102]);
});

test(
  'without a root creation time (an older spawn server) no process is excluded by age',
  { skip: process.platform !== 'win32' },
  async () => {
    tree.state.next = () => processTable([older]);
    const handle = await probeShellDescendants({ pid: ROOT });
    assert.deepEqual(handle.killPids, [5101]);
  }
);

test(
  'a process older than the root its parent link names is not its child',
  { skip: process.platform !== 'win32' },
  async () => {
    // The root's own table token, recorded once a read saw it alive, decides.
    const tracker = createProcessTreeTracker({ pid: ROOT });
    tree.state.next = () => processTable([{ pid: ROOT, token: filetime(0) }, older, consoleHost]);
    assert.equal(await tracker.capture(), true);
    tree.state.next = () => processTable([older, consoleHost]);
    assert.equal(await tracker.observe({ rootExited: true }), 'running');
    assert.deepEqual(
      tracker.live.map((entry) => entry.pid),
      [5102]
    );
    tree.state.next = () => processTable([older]);
    assert.equal(await tracker.observe({ rootExited: true }), 'gone');
  }
);

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
