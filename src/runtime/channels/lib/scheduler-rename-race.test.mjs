import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

// The scheduler's store writes go through `store`, so a test can hold one open.
const store = {};
const resetStore = () =>
  Object.assign(store, {
    claim: async (name) => ({ name }),
    success: async () => {},
    fired: async () => {},
  });
resetStore();
const realDb = await import('./schedules-db.mjs');
mock.module('./schedules-db.mjs', {
  namedExports: {
    ...realDb,
    claimScheduleRun: (...args) => store.claim(...args),
    getSchedule: async (name) => store.row(name),
    markScheduleSuccess: (...args) => store.success(...args),
    markFired: (...args) => store.fired(...args),
    markDone: async () => {},
    markScheduleFailure: async () => {},
    markScheduleSkipped: async () => {},
    setNextFire: async () => {},
  },
});
const { Scheduler } = await import('./scheduler.mjs');

function scheduler(schedule, runs) {
  // The stored row is the armed schedule as it was armed.
  const row = { ...schedule };
  store.row = (name) => (name === row.name ? row : null);
  return Object.assign(Object.create(Scheduler.prototype), {
    schedules: [schedule],
    promptsDir: makeTempDirSync('sched'),
    running: new Set(),
    renaming: new Set(),
    cronJobs: new Map(),
    oneShotTimers: new Map(),
    lastFired: new Map(),
    deferred: new Map(),
    notifyFailure() {},
    scheduleRunner: async (s) => {
      runs.push(s.name);
      return { sessionId: 's', result: '' };
    },
  });
}

// Store call `key` waits until the test lets it go; resolves once it is reached.
function holdStore(key, value) {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  store[key] = async () => {
    reached.resolve();
    await release.promise;
    return value;
  };
  return { reached: reached.promise, release: () => release.resolve() };
}

const rename = (s) => s.renameLocked('a', async () => ({ name: 'b' }), { newName: 'b' });

test('a rename while a cron fire is claiming its slot is refused, and the fire runs once', async () => {
  resetStore();
  const runs = [];
  const schedule = { name: 'a', prompt: 'go' };
  const s = scheduler(schedule, runs);
  const claim = holdStore('claim', { name: 'a' });
  const fire = s.onCronFire(schedule, new Date());
  await claim.reached;
  await assert.rejects(rename(s), /"a" is running/);
  claim.release();
  await fire;
  assert.deepEqual(runs, ['a']);
  assert.equal(s.running.size, 0, 'released once the fire settles');
});

test('a rename while a cron fire writes its completion stamps is refused until they are written', async () => {
  resetStore();
  const runs = [];
  const schedule = { name: 'a', prompt: 'go' };
  const s = scheduler(schedule, runs);
  const success = holdStore('success');
  const fire = s.onCronFire(schedule, new Date());
  await success.reached;
  await assert.rejects(rename(s), /"a" is running/);
  success.release();
  await fire;
  assert.equal(s.running.size, 0);
  assert.deepEqual(await rename(s), { name: 'b' });
});

test('a rename while a one-shot writes its fired stamp is refused until it is written', async () => {
  resetStore();
  const runs = [];
  const schedule = { name: 'a', prompt: 'go', whenAt: new Date(Date.now() - 1000).toISOString() };
  const s = scheduler(schedule, runs);
  const fired = holdStore('fired');
  const fire = s.fireOneShot(schedule);
  await fired.reached;
  await assert.rejects(rename(s), /"a" is running/);
  fired.release();
  await fire;
  assert.deepEqual(runs, ['a']);
  assert.equal(s.running.size, 0);
});

test('a cron fire that finds the name being renamed claims its slot but never runs, even if the rename ends first', async () => {
  resetStore();
  const runs = [];
  const schedule = { name: 'a', prompt: 'go' };
  const s = scheduler(schedule, runs);
  const claim = holdStore('claim', { name: 'a' });
  let fire;
  // The fire starts during the rename and its claim outlasts it.
  await s.renameLocked('a', async () => {
    fire = s.onCronFire(schedule, new Date());
    await claim.reached;
    return { name: 'b' };
  });
  claim.release();
  await fire;
  assert.deepEqual(runs, [], 'nothing runs under the old name');
  assert.ok(schedule.lastSkippedAt, 'the fire is recorded as a skip');
  assert.equal(s.running.size, 0);
});

test('a schedule deleted or re-timed after it was armed (its reload lost) never fires, and is no failure', async () => {
  resetStore();
  const failures = [];
  store.success = async () => assert.fail('a stale fire never succeeds');
  for (const stored of [null, { name: 'a', prompt: 'go', whenCron: '0 9 * * *' }, { name: 'a', prompt: 'go', enabled: false }]) {
    const runs = [];
    const schedule = { name: 'a', prompt: 'go', whenCron: '0 3 * * *' };
    const s = scheduler(schedule, runs);
    s.notifyFailure = (_schedule, why) => failures.push(why);
    store.row = () => stored;
    await s.onCronFire(schedule, new Date());
    assert.deepEqual(runs, [], JSON.stringify(stored));
    assert.ok(schedule.lastSkippedAt, 'recorded as a skip');
    assert.equal(schedule.lastFailedAt, undefined);
  }
  assert.deepEqual(failures, []);
  // Still stored as armed, with an edited prompt: it fires that prompt.
  const runs = [];
  const schedule = { name: 'a', prompt: 'go', whenCron: '0 3 * * *' };
  const s = scheduler(schedule, runs);
  const prompts = [];
  s.scheduleRunner = async (_s, { prompt }) => prompts.push(prompt) && { sessionId: 's', result: '' };
  store.success = async () => {};
  store.row = () => ({ ...schedule, prompt: 'edited' });
  await s.onCronFire(schedule, new Date());
  assert.deepEqual(prompts, ['edited']);
});

test('a schedule runner that throws synchronously still releases the name', async () => {
  resetStore();
  const s = scheduler({ name: 'a', prompt: 'go' }, []);
  s.scheduleRunner = () => {
    throw new Error('runner exploded');
  };
  await assert.rejects(s.fireTimedPrompt({ name: 'a' }, 'p', { awaitDispatch: true }), /runner exploded/);
  assert.equal(s.running.has('a'), false, 'an awaited fire releases it');
  assert.equal(await s.fireTimedPrompt({ name: 'a' }, 'p'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.running.has('a'), false, 'a fire-and-forget fire releases it');
});
