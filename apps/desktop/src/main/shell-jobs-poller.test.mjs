import assert from 'node:assert/strict';
import test from 'node:test';
import { shellJobsPollDelay } from './desktop-support.ts';
import { createShellJobsPoller } from './shell-jobs-poller.ts';
import { createSnapshotDeltaEncoder, isNoDelta } from './state-delta.ts';

// A background shell left running while the session idles is re-read on the
// poller's cadence. The runtime restates "time since the oldest job" on every
// read; only a real change to the job set may reach the lanes.

const flush = () => new Promise((resolve) => setImmediate(resolve));
const JOB = {
  taskId: 'shell_idle',
  command: 'npm run watch',
  cwd: 'C:/project',
  startedAt: '2026-03-01T10:00:00.000Z',
};

function fixture(listed = (jobs) => jobs) {
  let reads = 0;
  let jobs = [JOB];
  const changes = [];
  const poller = createShellJobsPoller({
    getEngineState: () => ({ clientHostPid: 4242, busy: false }),
    loadModule: async () => ({
      shellJobsStatus: () => {
        reads += 1;
        const label = `${reads}s`;
        return {
          count: jobs.length,
          elapsedLabel: label,
          jobs: listed(jobs),
          sessions: { sess_owner: { count: jobs.length, elapsedLabel: label, jobs: listed(jobs) } },
        };
      },
    }),
    onChange: (sessionIds) => changes.push([...sessionIds]),
  });
  return {
    poller,
    changes,
    get reads() {
      return reads;
    },
    setJobs(next) {
      jobs = next;
    },
  };
}

test('a held shell of a closed session is listed for every session whose folder sees it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = { ...JOB, taskId: 'shell_held', cwd: 'C:/project/app', terminationUnconfirmed: true };
  let orphaned = [];
  const changes = [];
  const poller = createShellJobsPoller({
    getEngineState: () => ({ clientHostPid: 4242, busy: false }),
    loadModule: async () => ({
      shellJobsStatus: () => ({ count: 0, elapsedLabel: '', jobs: [], sessions: {}, orphaned }),
      // Stands in for the runtime's folder/repository check.
      shellJobVisibleFrom: (job, cwd) => job.cwd.startsWith(cwd),
    }),
    onChange: (sessionIds, everySession) => changes.push([[...sessionIds], everySession]),
  });
  try {
    poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.deepEqual(poller.statusFor('sess_viewer', 'C:/project').jobs, []);
    orphaned = [held];
    t.mock.timers.tick(shellJobsPollDelay({ busy: false }, 0));
    await flush();
    assert.deepEqual(changes.at(-1), [[], true], 'every pane repaints when an orphan appears');
    const row = poller.statusFor('sess_viewer', 'C:/project').jobs[0];
    assert.equal(row.taskId, 'shell_held');
    assert.equal(row.terminationUnconfirmed, true, 'rendered as termination unconfirmed with its release action');
    assert.equal(poller.statusFor('sess_viewer', 'C:/project').count, 0, 'not counted as running');
    assert.deepEqual(poller.statusFor('sess_other', 'D:/elsewhere').jobs, []);
    assert.deepEqual(poller.statusFor('sess_viewer').jobs, [], 'no folder, nothing visible');
  } finally {
    poller.stop();
  }
});

async function pollTimes(t, count, afterEach = () => {}) {
  for (let index = 0; index < count; index += 1) {
    t.mock.timers.tick(5_000);
    await flush();
    afterEach();
  }
}

test('an idle background shell republishes nothing across repeated polls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const items = [{ id: 'u1', kind: 'user', text: 'watching' }];
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const frames = [];
  // Mirrors SessionHost.snapshotWithShellJobs: fresh copies on every publish.
  const publish = () => {
    const own = f.poller.statusFor('sess_owner');
    const host = f.poller.status;
    const wire = encoder.encode({
      sessionId: 'sess_owner',
      items,
      busy: false,
      shellJobs: { ...own, jobs: [...own.jobs] },
      hostShellJobs: { ...host, jobs: [...host.jobs] },
    });
    if (!isNoDelta(wire)) frames.push(wire);
  };
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.changes.length, 1, 'the first read publishes the running job');
    publish();
    await pollTimes(t, 30, publish);
    assert.ok(f.reads >= 30, `the runtime was polled (${f.reads} reads)`);
    assert.equal(f.changes.length, 1, 'a ticking label is not a change');
    assert.equal(frames.length, 1, 'only the baseline crossed the wire');
    assert.equal(f.poller.status.jobs[0].startedAt, JOB.startedAt, 'elapsed time derives from the job start');
    assert.equal(f.poller.status.elapsedLabel, '');

    // A real change still publishes.
    f.setJobs([JOB, { ...JOB, taskId: 'shell_second', command: 'npm test' }]);
    await pollTimes(t, 1);
    assert.equal(f.changes.length, 2);
    publish();
    assert.equal(frames.length, 2);
    assert.deepEqual(Object.keys(frames[1].sc).sort(), ['hostShellJobs', 'shellJobs']);
  } finally {
    f.poller.stop();
  }
});

test('a job turning "termination unconfirmed" is carried and republished', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.poller.statusFor('sess_owner').jobs[0].terminationUnconfirmed, undefined);
    f.setJobs([{ ...JOB, terminationUnconfirmed: true }]);
    await pollTimes(t, 1);
    assert.equal(f.changes.length, 2, 'the flag alone is a change');
    assert.equal(f.poller.statusFor('sess_owner').jobs[0].terminationUnconfirmed, true);
    assert.equal(f.poller.status.jobs[0].terminationUnconfirmed, true);
  } finally {
    f.poller.stop();
  }
});

test('jobs the list does not carry keep their aggregate elapsed label', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // An unlisted job is only readable through the label, so it still travels.
  const f = fixture(() => []);
  try {
    f.poller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(f.poller.status.count, 1);
    assert.equal(f.poller.status.elapsedLabel, '1s');
    assert.equal(f.poller.statusFor('sess_owner').elapsedLabel, '1s');
  } finally {
    f.poller.stop();
  }
});
