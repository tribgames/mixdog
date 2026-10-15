import assert from 'node:assert/strict';
import test from 'node:test';
import { shellJobsPollDelay } from './desktop-support.ts';
import { createShellJobsPoller } from './shell-jobs-poller.ts';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job(id) {
  return { taskId: id, command: id, cwd: 'C:/p', startedAt: 1 };
}

function fixture({ loads, state = { clientHostPid: 1, busy: false } } = {}) {
  const calls = { loads: 0, reads: [] };
  const changes = [];
  const engine = { state };
  const poller = createShellJobsPoller({
    getEngineState: () => engine.state,
    loadModule: () => {
      const next = loads ? loads[calls.loads] : undefined;
      calls.loads += 1;
      return next
        ? next.promise
        : Promise.resolve({
            shellJobsStatus: ({ clientHostPid }) => {
              calls.reads.push(clientHostPid);
              return { count: 1, jobs: [job(`pid${clientHostPid}`)], sessions: { s: { count: 1, jobs: [job(`pid${clientHostPid}`)] } } };
            },
          });
    },
    onChange: (ids) => changes.push([...ids]),
  });
  return { poller, calls, changes, engine };
}

function moduleFor(reads, jobId = 'a') {
  return {
    shellJobsStatus: ({ clientHostPid }) => {
      reads.push(clientHostPid);
      return { count: 1, jobs: [job(jobId)], sessions: { s: { count: 1, jobs: [job(jobId)] } } };
    },
  };
}

test('engine event bursts during a pending load coalesce into one follow-up poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const reads = [];
  const f = fixture({ loads: [gate] });
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    for (let i = 0; i < 5; i += 1) f.poller.onEngineEvent();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.calls.loads, 1, 'no parallel poll while one is outstanding');
    gate.resolve(moduleFor(reads));
    await flush();
    assert.equal(reads.length, 1);
    t.mock.timers.tick(0);
    await flush();
    assert.equal(reads.length, 2, 'exactly one immediate follow-up');
    t.mock.timers.tick(0);
    await flush();
    assert.equal(reads.length, 2, 'no further immediate polls');
  } finally {
    f.poller.stop();
  }
});

test('stop with an outstanding poll prevents publication and timer resurrection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const reads = [];
  const f = fixture({ loads: [gate] });
  f.poller.start();
  t.mock.timers.tick(0);
  await flush();
  f.poller.stop();
  gate.resolve(moduleFor(reads));
  await flush();
  f.poller.onEngineEvent();
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(reads.length, 0);
  assert.equal(f.changes.length, 0);
});

test('restart proceeds while the stale poll is discarded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stale = deferred();
  const reads = [];
  const f = fixture({ loads: [stale] });
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    f.poller.stop();
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    // The new lifecycle polls through the shared (still pending) load.
    stale.resolve(moduleFor(reads));
    await flush();
    assert.equal(reads.length, 1, 'only the new lifecycle read');
    assert.equal(f.changes.length, 1, 'published once');
    t.mock.timers.tick(shellJobsPollDelay(f.engine.state, 1));
    await flush();
    assert.equal(reads.length, 2, 'new lifecycle keeps its cadence');
  } finally {
    f.poller.stop();
  }
});

test('an owner change during module load never publishes the previous owner data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const reads = [];
  const f = fixture({ loads: [gate] });
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    f.engine.state = { clientHostPid: 2, busy: false };
    gate.resolve(moduleFor(reads));
    await flush();
    assert.deepEqual(reads, [], 'owner 1 was never read');
    assert.equal(f.changes.length, 0);
    t.mock.timers.tick(0);
    await flush();
    assert.deepEqual(reads, [2], 'immediate re-poll reads the new owner');
    assert.equal(f.changes.length, 1);
  } finally {
    f.poller.stop();
  }
});

test('a rejected module load is retried on the next poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failing = deferred();
  const reads = [];
  const f = fixture({ loads: [failing] });
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    failing.reject(new Error('load failed'));
    await flush();
    assert.equal(f.changes.length, 0);
    t.mock.timers.tick(shellJobsPollDelay(f.engine.state, 0));
    await flush();
    assert.equal(f.calls.loads, 2, 'the load was retried');
    assert.equal(f.changes.length, 1, 'the retry published');
    assert.equal(reads.length, 0);
  } finally {
    f.poller.stop();
  }
});

test('cadence is unchanged: idle delay without events, active delay with jobs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.calls.reads.length, 1);
    const active = shellJobsPollDelay(f.engine.state, 1);
    t.mock.timers.tick(active - 1);
    await flush();
    assert.equal(f.calls.reads.length, 1, 'not polled before the delay');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.calls.reads.length, 2, 'polled at the delay');
    f.poller.onEngineEvent();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.calls.reads.length, 2, 'an event that does not shorten the delay is not an immediate poll');
  } finally {
    f.poller.stop();
  }
});

// A desktop pane's shell is published by a shard: the owner-wide count stays 0
// and the job only appears in a session bucket.
function freshFixture() {
  const scans = { count: 0, jobs: [job('shell_a')], finished: [] };
  const changes = [];
  const poller = createShellJobsPoller({
    getEngineState: () => ({ clientHostPid: 1, busy: false }),
    loadModule: async () => ({
      shellJobsStatus: () => {
        throw new Error('the cache-only read must not be used');
      },
      shellJobsStatusFresh: async () => {
        scans.count += 1;
        return {
          count: 0,
          jobs: [],
          sessions: {
            s: { count: scans.jobs.length, jobs: [...scans.jobs], finished: [...scans.finished] },
          },
        };
      },
    }),
    onChange: (ids) => changes.push([...ids]),
  });
  return { poller, scans, changes };
}

test('a settled shell is visible on the very next poll, with no extra interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = freshFixture();
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.poller.statusFor('s').count, 1);
    f.scans.jobs = [];
    f.scans.finished = [{ ...job('shell_a'), status: 'completed', exitCode: 0, finishedAt: 2 }];
    t.mock.timers.tick(shellJobsPollDelay({ busy: false }, 1));
    await flush();
    assert.equal(f.scans.count, 2);
    assert.equal(f.poller.statusFor('s').count, 0);
    assert.equal(f.poller.statusFor('s').finished[0].taskId, 'shell_a');
    assert.deepEqual(f.changes.at(-1), ['s']);
  } finally {
    f.poller.stop();
  }
});

test('a running shell in a session bucket polls at the active cadence even with a zero aggregate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = freshFixture();
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.poller.status.count, 0);
    const active = shellJobsPollDelay({ busy: false }, 1);
    assert.equal(active, 1_000);
    t.mock.timers.tick(active - 1);
    await flush();
    assert.equal(f.scans.count, 1, 'not polled before the active delay');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.scans.count, 2, 'polled after 1s, not 5s');
  } finally {
    f.poller.stop();
  }
});

