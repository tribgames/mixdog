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
test('strict descendant enumeration rejects a failed OS query rather than returning an empty list', async () => {
  await assert.rejects(collectDescendantProcesses(process.pid, { strict: true }), /enumeration denied/);
  assert.deepEqual(
    await collectDescendantProcesses(process.pid),
    [],
    'legacy best-effort callers retain their contract'
  );
});
