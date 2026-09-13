import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalContinuation } from './goal-continuation.mjs';
import { createSessionFlow } from './session-flow.mjs';

const tick = () => new Promise(setImmediate);

function fixture(t, { busy = true, status = 'active', remote = false } = {}) {
  let current = {
    id: 'goal-closeout', revision: 1, status, objective: 'Finish the approved work',
    timeMode: 'duration', timeLimitMs: 60_000, timeUsedMs: 50_000, remainingMs: 10_000,
    tasks: [{ id: 'task_1', text: 'Verify the result', status: 'completed', kind: 'verification' }],
  };
  const state = { busy, commandBusy: false, sessionRemoteAttached: remote, sessionId: 'session-closeout', goal: current };
  const pending = [];
  const aborts = [];
  const reminders = [];
  let listener;
  const controller = createGoalContinuation({
    runtime: {
      id: state.sessionId,
      goalStatus: () => current,
      goalContinuation: () => ({
        run: current.status === 'active', goal: current, prompt: 'Continue approved work',
      }),
      goalTurnSettled: async () => current,
      onGoalStatusChange: (next) => { listener = next; return () => {}; },
      markGoalReminder: (reason) => reminders.push(reason),
      abort: (reason) => aborts.push(reason),
    },
    flags: {},
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    getPending: () => pending,
    enqueue: (content, options) => {
      assert.equal(state.goal.status, 'duration_reached', 'the stop state must precede closeout delivery');
      pending.push({ content, ...options });
      return true;
    },
  });
  t.after(() => controller.disposeGoalContinuation());
  return {
    state, pending, aborts, reminders, controller,
    change(patch) {
      current = { ...current, ...patch };
      listener({ sessionId: state.sessionId, goal: current });
    },
    expire() { this.change({ status: 'duration_reached', remainingMs: 0, timeUsedMs: 60_000, revision: 2 }); },
  };
}

for (const busy of [true, false]) {
  test(`deadline closeout preserves the current turn and is delivered once (busy=${busy})`, async (t) => {
    const f = fixture(t, { busy });
    f.expire();
    assert.deepEqual(f.aborts, []);
    assert.equal(f.pending.length, 1);
    assert.equal(f.pending[0].mode, 'goal-closeout');
    assert.equal(f.pending[0].priority, busy ? 'next' : 'later');
    assert.equal(f.pending[0].isMeta, true);
    assert.equal(f.pending[0].abortDiscardOnAbort, true);
    assert.equal(f.controller.shouldRunGoalContinuation(f.pending[0]), true);
    f.change({ revision: 3, objective: 'The current authoritative objective' });
    assert.equal(f.pending.length, 1);
    assert.match(f.pending[0].content, /The current authoritative objective/);
    f.pending.length = 0;
    f.change({ revision: 3 });
    await f.controller.onGoalTurnSettled({ status: 'done' });
    await tick();
    assert.equal(f.pending.length, 0);
  });
}

test('a waiting user prompt receives the stopped-state reminder without an extra automatic turn', async (t) => {
  const f = fixture(t, { busy: false });
  f.pending.push({ mode: 'prompt', content: 'User correction' });
  f.expire();
  await tick();
  assert.deepEqual(f.pending, [{ mode: 'prompt', content: 'User correction' }]);
  assert.deepEqual(f.reminders, ['deadline-reached']);
});

test('new user input takes over a queued closeout without losing its stopped-state context', async (t) => {
  const f = fixture(t);
  f.expire();
  f.controller.archiveCompletedGoalOnUserInput();
  assert.deepEqual(f.pending, []);
  assert.deepEqual(f.reminders, ['deadline-reached']);
  await tick();
  f.change({ revision: 3 });
  assert.deepEqual(f.pending, []);
});

test('a replacement Goal cannot receive its predecessor closeout', (t) => {
  const f = fixture(t);
  f.expire();
  const entry = f.pending[0];
  f.change({ id: 'different-goal', status: 'duration_reached' });
  assert.equal(f.controller.shouldRunGoalContinuation(entry), false);
  assert.deepEqual(f.pending, []);
});

for (const status of ['active', 'paused', 'complete']) {
  test(`a queued closeout becomes invalid when its Goal is ${status}`, async (t) => {
    const f = fixture(t);
    f.expire();
    const entry = f.pending[0];
    f.change({ status, revision: 3 });
    assert.equal(f.controller.shouldRunGoalContinuation(entry), false);
    assert.equal(f.pending.some((item) => item.mode === 'goal-closeout'), false);
  });
}

test('attaching to an already expired Goal or a remote view does not start a closeout turn', async (t) => {
  for (const options of [{ status: 'duration_reached', busy: false }, { remote: true }]) {
    const f = fixture(t, options);
    f.expire();
    await tick();
    assert.deepEqual(f.pending, []);
    assert.deepEqual(f.aborts, []);
  }
});

function queueFixture({ busy, valid }) {
  const state = { busy, commandBusy: false, queued: [] };
  const pending = [];
  const turns = [];
  let nextId = 0;
  const bag = {
    runtime: { id: 'session-closeout-queue' },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `queued-${++nextId}`,
    tuiDebug() {},
    pushUserOrSyntheticItem() { assert.fail('closeout must not create a user bubble'); },
    flushDeferredExecutionPendingResumeKick() {},
    shouldRunGoalContinuation: () => valid,
    runTurn: async (content, options) => { turns.push({ content, options }); return 'done'; },
  };
  return { state, pending, turns, flow: createSessionFlow(bag) };
}

for (const valid of [true, false]) {
  test(`the real steering queue ${valid ? 'delivers' : 'rejects'} a deadline closeout without ending the turn`, () => {
    const f = queueFixture({ busy: true, valid });
    f.flow.enqueue('Stop new Goal work and report the verified outcome.', {
      mode: 'goal-closeout', priority: 'next', goalId: 'goal-closeout',
      isMeta: true, suppressDisplay: true, abortDiscardOnAbort: true,
    });
    const messages = f.flow.drainPendingSteering();
    assert.equal(messages.length, valid ? 1 : 0);
    assert.deepEqual(f.turns, []);
    assert.deepEqual(f.state.queued, []);
    assert.deepEqual(f.pending, []);
  });

  test(`the real idle queue ${valid ? 'delivers' : 'rejects'} a deadline closeout without replay on cancellation`, async () => {
    const f = queueFixture({ busy: false, valid });
    f.flow.enqueue('Report the stopped Goal.', {
      mode: 'goal-closeout', priority: 'later', goalId: 'goal-closeout',
      isMeta: true, suppressDisplay: true, abortDiscardOnAbort: true,
    });
    await tick();
    assert.equal(f.turns.length, valid ? 1 : 0);
    if (valid) {
      assert.deepEqual(f.turns[0].options.requeueOnAbort, []);
      assert.equal(f.turns[0].options.promptSource, 'goal-closeout');
    }
    assert.deepEqual(f.pending, []);
    assert.deepEqual(f.state.queued, []);
  });
}
