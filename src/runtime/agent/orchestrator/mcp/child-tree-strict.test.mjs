import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Every enumerator started (on the process-runner worker), and how the next
// one behaves: 'deny' fails at once, 'hang' never answers until the runner
// kills it at the deadline it was given (ETIMEDOUT, as run-child.mjs does).
const spawned = [];
let behavior = 'deny';
mock.module('../../../shared/process-runner.mjs', {
  namedExports: {
    runProcessOffThread: (command, args, { timeoutMs }) => {
      const child = { command, args, timeoutMs, alive: true };
      spawned.push(child);
      return new Promise((resolve, reject) => {
        if (behavior === 'manual') {
          // Answers when the test says so, with a table naming this process.
          child.answer = () => {
            child.alive = false;
            const row =
              process.platform === 'win32'
                ? `${process.pid} 1 node.exe 2026-10-18T00:00:00`
                : `${process.pid} 1 ${process.pid} S node Sun Oct 18 00:00:00 2026`;
            resolve({ code: 0, stdout: `${row}\n`, stderr: '' });
          };
          return;
        }
        if (behavior === 'deny') {
          queueMicrotask(() => {
            child.alive = false;
            reject(new Error('process enumeration denied'));
          });
          return;
        }
        setTimeout(() => {
          child.alive = false;
          reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
        }, timeoutMs);
      });
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
    assert.equal(spawned[0].timeoutMs, ENUMERATION_DEADLINE_MS, 'the runner kills the enumerator at the deadline');
    assert.equal(spawned[0].alive, false);
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

// Runs while no read is in flight (the watch test below leaves one hanging).
test('concurrent observers share one enumerator at a time, each served by a read begun after it asked', async () => {
  behavior = 'manual';
  spawned.length = 0;
  try {
    const first = readProcessTable();
    // A pre-kill capture may join the running read.
    const capture = readProcessTable({ shared: true });
    // Observers asking while it runs must not get it: they share the next one.
    const observers = Array.from({ length: 8 }, () => readProcessTable());
    assert.equal(spawned.length, 1, 'no enumerator is started beside the running one');
    spawned[0].answer();
    const firstTable = await first;
    assert.equal(await capture, firstTable);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawned.length, 2, 'one more read, begun after the first settled, serves every observer');
    spawned[1].answer();
    const tables = await Promise.all(observers);
    assert.ok(tables.every((table) => table === tables[0] && table !== firstTable));
    assert.equal(tables[0].nameOf.has(process.pid), true);
    // Nothing in flight: the next observer starts its own read at once.
    const alone = readProcessTable();
    assert.equal(spawned.length, 3);
    spawned[2].answer();
    await alone;
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
