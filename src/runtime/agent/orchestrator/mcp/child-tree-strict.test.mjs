import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

// Every spawned enumerator, and how the next one behaves: 'deny' fails at
// once, 'hang' never answers until it is killed.
const spawned = [];
let behavior = 'deny';
mock.module('node:child_process', {
  namedExports: {
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = Object.assign(new EventEmitter(), {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      });
      child.alive = true;
      child.kill = (signal) => {
        child.killedWith = signal;
        child.alive = false;
        return true;
      };
      spawned.push(child);
      if (behavior === 'deny') {
        queueMicrotask(() => {
          child.alive = false;
          child.emit('error', new Error('process enumeration denied'));
          child.emit('close', 1);
        });
      }
      return child;
    },
  },
});
const { collectDescendantProcesses, readProcessTable, ENUMERATION_DEADLINE_MS } = await import('./child-tree.mjs');

test('a hung enumerator is killed at the deadline and its snapshot rejected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  behavior = 'hang';
  spawned.length = 0;
  try {
    let settled = null;
    const read = readProcessTable().then(
      () => {
        settled = 'resolved';
      },
      (error) => {
        settled = error;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawned.length, 1);
    t.mock.timers.tick(ENUMERATION_DEADLINE_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, null, 'nothing settles before the deadline');
    assert.equal(spawned[0].alive, true);
    t.mock.timers.tick(1);
    await read;
    assert.match(String(settled?.message), /timed out/);
    assert.equal(spawned[0].killedWith, 'SIGKILL', 'the enumerator is killed');
    assert.equal(spawned[0].stdout.destroyed, true);
    // Best-effort callers get an empty answer, not a hang.
    const legacy = collectDescendantProcesses(process.pid);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(ENUMERATION_DEADLINE_MS);
    assert.deepEqual(await legacy, []);
    assert.equal(spawned.length, 2);
    assert.equal(
      spawned.filter((child) => child.alive).length,
      0,
      'repeated reads never leave an earlier enumerator running'
    );
  } finally {
    behavior = 'deny';
  }
});

test('a termination watch never starts a pass beside the previous pass’s enumerator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  behavior = 'hang';
  spawned.length = 0;
  const { createProcessTreeTracker, watchTermination, TERMINATION_RECHECK_MS } = await import(
    '../tools/lib/shell-descendants.mjs'
  );
  const stop = watchTermination({
    tracker: createProcessTreeTracker({ pid: 4242, exitObserved: true }),
    onTerminated: () => assert.fail('nothing was confirmed'),
  });
  try {
    const span = 3 * (ENUMERATION_DEADLINE_MS + TERMINATION_RECHECK_MS);
    for (let elapsed = 0; elapsed < span; elapsed += 250) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(spawned.filter((child) => child.alive).length <= 1, 'at most one enumerator at a time');
      t.mock.timers.tick(250);
    }
    assert.ok(spawned.length >= 3, 'the watch kept re-checking');
  } finally {
    stop();
    behavior = 'deny';
  }
});

test('strict descendant enumeration rejects a failed OS query rather than returning an empty list', async () => {
  await assert.rejects(collectDescendantProcesses(process.pid, { strict: true }), /enumeration denied/);
  assert.deepEqual(
    await collectDescendantProcesses(process.pid),
    [],
    'legacy best-effort callers retain their contract'
  );
});
