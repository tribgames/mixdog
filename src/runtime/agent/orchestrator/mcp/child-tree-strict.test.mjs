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
          // Answers when the test says so; every valid table names this process.
          child.answer = (rows = []) => {
            child.alive = false;
            const stdout = [{ pid: process.pid }, ...rows]
              .map(({ pid, ppid = 1, pgid = pid }) =>
                process.platform === 'win32'
                  ? `${pid} ${ppid} node.exe 2026-10-18T00:00:00`
                  : `${pid} ${ppid} ${pgid} S node Sun Oct 18 00:00:00 2026`
              )
              .join('\n');
            resolve({ code: 0, stdout, stderr: '' });
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
test('captures and observers share a fresh read, preserving children born after an in-flight snapshot', async () => {
  behavior = 'manual';
  spawned.length = 0;
  const { createProcessTreeTracker } = await import('../tools/lib/shell-descendants.mjs');
  const root = process.pid + 1_000_000;
  const child = root + 1;
  const tracker = createProcessTreeTracker({ pid: root });
  try {
    const first = readProcessTable();
    // The root existed when this read began, but its new child did not.
    const capture = tracker.capture();
    // Captures and observers share the next read without parallel enumerators.
    const observers = Array.from({ length: 8 }, () => readProcessTable());
    assert.equal(spawned.length, 1, 'no enumerator is started beside the running one');
    spawned[0].answer([{ pid: root }]);
    const firstTable = await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawned.length, 2, 'one more read, begun after the first settled, serves every observer');
    spawned[1].answer([{ pid: root }, { pid: child, ppid: root }]);
    assert.equal(await capture, true);
    const tables = await Promise.all(observers);
    assert.ok(tables.every((table) => table === tables[0] && table !== firstTable));
    assert.equal(tables[0].nameOf.has(process.pid), true);
    // After the kill, the child has neither a parent nor a group link to root.
    const survivor = tracker.observe({ rootExited: true });
    assert.equal(spawned.length, 3);
    spawned[2].answer([{ pid: child }]);
    assert.equal(await survivor, 'running', 'the pre-kill capture must include the new child');
    assert.deepEqual(tracker.live.map((entry) => entry.pid), [child]);
    const finished = tracker.observe({ rootExited: true });
    spawned[3].answer();
    assert.equal(await finished, 'gone');
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
