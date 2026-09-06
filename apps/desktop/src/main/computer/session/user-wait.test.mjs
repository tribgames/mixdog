import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerUseCoordinator } from './coordinator.ts';
import { createComputerUserWait } from './user-wait.ts';

function fixture(t, reason = 'user_input_active') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const coordinator = new ComputerUseCoordinator();
  let sequence = 0, held = false, ready = true, lastInput = 0, reads = 0, resumes = 0;
  let beforeResume;
  const manager = createComputerUserWait({
    coordinator, now: () => Date.now(), enabled: () => true,
    observe: async () => {
      reads++;
      return { ready, monitor: 'one', sequence, held, idleMs: Date.now() - lastInput };
    },
    resume: async (generation, signal, recheck) => {
      beforeResume?.();
      if (!await recheck() || signal.aborted) throw new Error('computer_resume_stale');
      resumes++;
      coordinator.resumeAfterUserTakeover(generation);
    },
  });
  coordinator.beginCommand({ sessionId: 'a', action: 'type', mode: 'foreground' });
  coordinator.pauseForUser(reason);
  t.after(() => { manager.dispose(); coordinator.reset(); });
  return {
    coordinator, manager,
    input() { sequence++; lastInput = Date.now(); },
    hold(value) { held = value; },
    fail() { ready = false; },
    beforeResume(callback) { beforeResume = callback; },
    counts: () => ({ reads, resumes }),
    async tick(ms = 500) {
      t.mock.timers.tick(ms);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    async advance(ms) { for (let i = 0; i < ms / 500; i++) await this.tick(); },
  };
}

test('five quiet seconds release a pending user wait; new input restarts the entire interval', async (t) => {
  const f = fixture(t);
  const pending = f.manager.wait('a');
  await f.advance(4500);
  f.input();
  await f.advance(5000);
  assert.equal(f.coordinator.snapshot().userControlActive, true);
  await f.tick();
  assert.equal(await pending, 'resumed');
  assert.equal(f.counts().resumes, 1);
});

test('held keys/buttons wait without treating ordinary input as an observation failure', async (t) => {
  const f = fixture(t);
  f.hold(true);
  await f.advance(7000);
  assert.equal(f.coordinator.snapshot().takeoverReason, 'user_input_active');
  assert.equal(f.counts().resumes, 0);
  f.hold(false); f.input();
  await f.advance(5500);
  assert.equal(f.counts().resumes, 1);
});

for (const reason of ['user_stop', 'user_pause', 'user_takeover', 'input_recovery_unconfirmed', 'input_observation_unavailable', 'screen_locked']) {
  test(`${reason} cannot auto-resume from elapsed time`, async (t) => {
    const f = fixture(t, reason);
    assert.equal(await (async () => { const p = f.manager.wait('a', 1000); await f.advance(1500); return p; })(), 'timeout');
    await f.advance(10000);
    assert.deepEqual(f.counts(), { reads: 0, resumes: 0 });
    assert.equal(f.coordinator.snapshot().userControlActive, true);
  });
}

test('cleanup must finish before observing and failed observation requires confirmation', async (t) => {
  const f = fixture(t);
  const finish = f.coordinator.beginCleanup('a');
  await f.advance(6000);
  assert.equal(f.counts().reads, 0);
  finish(true);
  f.fail();
  await f.tick();
  assert.equal(f.coordinator.snapshot().takeoverReason, 'input_observation_unavailable');
  await f.advance(6000);
  assert.equal(f.counts().resumes, 0);
});

test('input arriving at the final resume check cannot release control', async (t) => {
  const f = fixture(t);
  f.beforeResume(() => f.input());
  await f.advance(12000);
  assert.equal(f.counts().resumes, 0);
  assert.equal(f.coordinator.snapshot().takeoverReason, 'user_input_active');
});

test('manual mode, cancellation and duplicate wait budgets are explicit', async (t) => {
  const f = fixture(t);
  f.manager.configure(0);
  const abort = new AbortController();
  const pending = f.manager.wait('a', 10000, abort.signal);
  await assert.rejects(f.manager.wait('a'), /capacity_exhausted/);
  await f.advance(6000);
  assert.equal(f.counts().resumes, 0);
  abort.abort();
  assert.equal(await pending, 'cancelled');
  assert.throws(() => f.manager.configure(-1), /idle_seconds_invalid/);
  const next = f.manager.wait('a');
  f.coordinator.resumeAfterUserTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal(await next, 'resumed');
});

test('a changed interval starts a new quiet period; disposal cancels rather than resumes', async (t) => {
  const f = fixture(t);
  await f.advance(4000);
  f.manager.configure(1);
  await f.tick();
  await f.tick();
  assert.equal(f.counts().resumes, 0);
  const pending = f.manager.wait('a');
  f.manager.dispose();
  assert.equal(await pending, 'cancelled');
  await f.advance(3000);
  assert.equal(f.counts().resumes, 0);
});
