import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RETRY_CONTINUE_INSTRUCTION,
  createQuotaResumeLane,
  failedTurnRetryPrompt,
  latestQuotaFailure,
} from './quota-resume.mjs';
import { createGoalContinuation } from './goal-continuation.mjs';
import { createSubmissionIntake } from './session-api/intake/submission.mjs';
import { createContextState } from './context-state.mjs';
import { createSessionRouteApi } from './session-api/routes.mjs';
import { createSessionResetActions } from './session-api/lifecycle/session-reset.mjs';
import {
  deferQuotaResumeEntry,
  publicQuotaResume,
  quotaResumeEntry,
  quotaSuspendedGoal,
  noteQuotaSuspendedGoal,
  reloadQuotaResumeStore,
  scheduleQuotaResumeEntry,
  setQuotaAutoResumeEnabled,
} from '../../runtime/shared/quota-resume-store.mjs';

const SESSION = 'sess_quota_lane';
const RESET_AT = 2_000_000_000_000;

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-resume-lane-'));
  const overrides = { MIXDOG_DATA_DIR: dir, MIXDOG_CONFIG_DIR: dir, MIXDOG_SKIP_USER_DATA_BACKUP: '1' };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  reloadQuotaResumeStore();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadQuotaResumeStore();
    rmSync(dir, { recursive: true, force: true });
  });
}

const quota = (resetAt = RESET_AT) => ({ provider: 'openai-oauth', model: 'gpt-x', resetAt });
const failedTurn = ({ resetAt = RESET_AT, sampled = false, text = 'build the parser', images = null } = {}) => [
  { id: 'u0', kind: 'user', text: 'earlier' },
  { id: 'a0', kind: 'assistant', text: 'earlier answer' },
  { id: 'd0', kind: 'turndone', status: 'done' },
  { id: 'u1', kind: 'user', text, ...(images ? { images } : {}) },
  ...(sampled ? [{ id: 'a1', kind: 'assistant', text: 'partial work' }] : []),
  { id: 'n1', kind: 'notice', text: 'limit reached' },
  { id: 'd1', kind: 'turndone', status: 'failed', quota: quota(resetAt) },
];

function harness(t, { items = failedTurn(), runtime = {} } = {}) {
  isolateDataDir(t);
  let state = { sessionId: SESSION, items, busy: false, commandBusy: false, queued: [], quotaResume: null };
  const pending = [];
  const enqueued = [];
  const calls = [];
  let nextId = 0;
  const bag = {
    runtime: { id: SESSION, interruptTaskWait() {}, ...runtime },
    flags: { admission: 'open', disposed: false },
    pending,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `id-${++nextId}`,
    autoClearBeforeSubmit: async () => calls.push('auto-clear'),
    enqueue: (text, options) => {
      enqueued.push({ text, options });
      calls.push(['enqueue', text]);
      return true;
    },
  };
  Object.assign(bag, createQuotaResumeLane(bag));
  // A whole turn settlement: queued at the failed turndone, Goal noted after.
  bag.onQuotaTurnSettled = (detail) => {
    const entry = bag.beginQuotaSettlement();
    bag.finishQuotaSettlement(detail);
    return entry;
  };
  t.after(() => bag.disposeQuotaResume());
  return {
    bag,
    enqueued,
    calls,
    pending,
    get state() {
      return state;
    },
    patch(next) {
      state = { ...state, ...next };
    },
  };
}

test('transcript helpers mirror the desktop retry semantics', () => {
  assert.deepEqual(latestQuotaFailure(failedTurn()), { turnKey: 'turn:u1', quota: quota() });
  assert.deepEqual(latestQuotaFailure(failedTurn({ resetAt: null })).quota.resetAt, null);
  assert.equal(latestQuotaFailure([...failedTurn(), { id: 'u2', kind: 'user', text: 'next' }]), null);
  assert.equal(failedTurnRetryPrompt(failedTurn(), 'turn:u1'), 'build the parser');
  assert.equal(failedTurnRetryPrompt(failedTurn({ sampled: true }), 'turn:u1'), RETRY_CONTINUE_INSTRUCTION);
  assert.equal(failedTurnRetryPrompt(failedTurn({ text: '', images: [{ token: 'img' }] }), 'turn:u1'), null);
  assert.equal(failedTurnRetryPrompt(failedTurn({ images: [{ token: 'img' }] }), 'turn:u1'), null);
  assert.equal(
    failedTurnRetryPrompt(failedTurn({ images: [{ token: 'img' }], sampled: true }), 'turn:u1'),
    RETRY_CONTINUE_INSTRUCTION
  );
});

test('restoration rekeys a provable legacy user retry and its Goal atomically', (t) => {
  const h = harness(t, {
    items: [
      { kind: 'user', id: 'hist_session_0_1', text: 'original' },
      { kind: 'turndone', id: 'hist_session_0_2', checkpointId: 'it_1', status: 'failed', quota: quota() },
    ],
  });
  const old = scheduleQuotaResumeEntry({ sessionId: SESSION, turnKey: 'turn:it_1', ...quota() });
  noteQuotaSuspendedGoal(SESSION, old.turnKey, 'goal-1');
  assert.equal(h.bag.reconcileQuotaResume(), true);
  reloadQuotaResumeStore();
  assert.equal(quotaResumeEntry(SESSION).turnKey, 'checkpoint:it_1');
  assert.ok(quotaResumeEntry(SESSION).generation > old.generation);
  assert.equal(quotaSuspendedGoal(SESSION, 'checkpoint:it_1'), 'goal-1');
  assert.equal(h.bag.fireQuotaResume({ generation: old.generation }), 'stale');
});

test('restoration never guesses which failure an old notification reservation belongs to', (t) => {
  const h = harness(t, {
    items: [{ kind: 'turndone', id: 'hist_session_0_2', checkpointId: 'it_1', status: 'failed', quota: quota() }],
  });
  const old = scheduleQuotaResumeEntry({ sessionId: SESSION, turnKey: 'segment:it_2', ...quota() });
  assert.equal(h.bag.reconcileQuotaResume(), false);
  assert.equal(quotaResumeEntry(SESSION).generation, old.generation);
});

test('a quota failure with a known reset schedules a resume while the setting is on', (t) => {
  const h = harness(t);
  const entry = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  assert.equal(entry.turnKey, 'turn:u1');
  assert.deepEqual(h.state.quotaResume, {
    state: 'waiting',
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: RESET_AT,
    attempts: 0,
  });
  assert.equal(quotaSuspendedGoal(SESSION, 'turn:u1'), 'goal-1');
});

test('the setting off or an unknown reset never schedules', (t) => {
  const unknown = harness(t, { items: failedTurn({ resetAt: null }) });
  assert.equal(unknown.bag.onQuotaTurnSettled(), null);
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(unknown.state.quotaResume, null);
  assert.throws(() => unknown.bag.scheduleQuotaResume(SESSION), /known reset time/);

  const off = harness(t);
  setQuotaAutoResumeEnabled(false);
  assert.equal(off.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' }), null);
  assert.equal(quotaResumeEntry(SESSION), null);
  // The Goal note is kept, so an explicit request can still revive it.
  assert.equal(quotaSuspendedGoal(SESSION, 'turn:u1'), 'goal-1');
  assert.equal(off.bag.scheduleQuotaResume(SESSION), true);
  assert.equal(off.state.quotaResume.turnKey, 'turn:u1');
  assert.throws(() => off.bag.scheduleQuotaResume('sess_other'), /not the active session/);
});

test('the snapshot field follows the durable entry and reaches the route state', (t) => {
  const h = harness(t);
  const entry = h.bag.onQuotaTurnSettled();
  deferQuotaResumeEntry(SESSION, entry.generation, { resetAt: RESET_AT + 300_000, attempts: 1 });
  assert.equal(h.state.quotaResume.attempts, 1);
  assert.equal(h.state.quotaResume.resetAt, RESET_AT + 300_000);
  const { baseRouteState } = createContextState({
    runtime: { id: SESSION },
    getState: () => h.state,
    updateState: () => {},
    getPendingSessionReset: () => false,
    getQuotaResume: () => publicQuotaResume(quotaResumeEntry(SESSION)),
  });
  assert.equal(baseRouteState().quotaResume, h.state.quotaResume);
  assert.equal(h.bag.cancelQuotaResume(SESSION), true);
  assert.equal(h.state.quotaResume, null);
  assert.equal(baseRouteState().quotaResume, null);
});

test('a fire replays the unanswered prompt as a failed-turn retry and clears the wait', (t) => {
  const h = harness(t);
  const { generation } = h.bag.onQuotaTurnSettled();
  assert.equal(h.bag.fireQuotaResume({ generation }), 'fired');
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0].text, 'build the parser');
  assert.equal(h.enqueued[0].options.retryFailedTurn, true);
  assert.equal(h.enqueued[0].options.mode, 'prompt');
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(h.state.quotaResume, null);
  // The automatic resume never starts the idle auto-clear.
  assert.equal(h.calls.includes('auto-clear'), false);
});

test('a turn that already sampled output resumes with the continuation instruction', (t) => {
  const h = harness(t, { items: failedTurn({ sampled: true }) });
  const { generation } = h.bag.onQuotaTurnSettled();
  assert.equal(h.bag.fireQuotaResume({ generation }), 'fired');
  assert.equal(h.enqueued[0].text, RETRY_CONTINUE_INSTRUCTION);
});

test('a busy session is never fired and keeps its wait', (t) => {
  const h = harness(t);
  const { generation } = h.bag.onQuotaTurnSettled();
  for (const patch of [{ busy: true }, { commandBusy: true }]) {
    h.patch(patch);
    assert.equal(h.bag.fireQuotaResume({ generation }), 'busy');
    h.patch({ busy: false, commandBusy: false });
  }
  h.pending.push({ id: 'queued', mode: 'task-notification' });
  assert.equal(h.bag.fireQuotaResume({ generation }), 'busy');
  h.pending.length = 0;
  h.bag.flags.draining = true;
  assert.equal(h.bag.fireQuotaResume({ generation }), 'busy');
  h.bag.flags.draining = false;
  assert.equal(h.enqueued.length, 0);
  assert.equal(quotaResumeEntry(SESSION).generation, generation);
  assert.equal(h.bag.fireQuotaResume({ generation }), 'fired');
});

test('a media-only prompt is not promised an automatic replay', (t) => {
  const h = harness(t, { items: failedTurn({ text: '', images: [{ token: 'img-1' }] }) });
  assert.equal(h.bag.onQuotaTurnSettled(), null);
  assert.throws(() => h.bag.scheduleQuotaResume(SESSION), /cannot be resumed automatically/);
  assert.equal(h.enqueued.length, 0);
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(h.state.quotaResume, null);
});

test('a later turn supersedes the wait', (t) => {
  const h = harness(t);
  const { generation } = h.bag.onQuotaTurnSettled();
  h.patch({ items: [...h.state.items, { id: 'u2', kind: 'user', text: 'other' }, { id: 'd2', kind: 'turndone' }] });
  assert.equal(h.bag.fireQuotaResume({ generation }), 'superseded');
  assert.equal(h.enqueued.length, 0);
  assert.equal(quotaResumeEntry(SESSION), null);
});

test('every cancel path wins over a fire the scheduler already started', async (t) => {
  const cancels = {
    'user input': (h) => createSubmissionIntake(h.bag).submit('do something else'),
    cancelQuotaResume: (h) => h.bag.cancelQuotaResume(SESSION),
    'setting off': () => setQuotaAutoResumeEnabled(false),
  };
  for (const [name, cancel] of Object.entries(cancels)) {
    const h = harness(t, { runtime: { continueSessionInModel: async () => true } });
    // The scheduler has read the entry and is mid-reading when the cancel lands.
    const { generation } = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
    await cancel(h);
    assert.equal(quotaResumeEntry(SESSION), null, name);
    assert.equal(h.state.quotaResume, null, name);
    assert.equal(h.bag.fireQuotaResume({ generation }), 'stale', name);
    assert.equal(
      h.enqueued.some((entry) => entry.options?.retryFailedTurn),
      false,
      `${name}: no retry after the cancel`
    );
  }
});

test('retryFailedTurn is the desktop retry: a user submission of the same prompt', async (t) => {
  const h = harness(t, { items: failedTurn({ sampled: true }) });
  h.bag.onQuotaTurnSettled();
  assert.equal(await h.bag.retryFailedTurn(SESSION, 'turn:u1'), true);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0].text, RETRY_CONTINUE_INSTRUCTION);
  assert.equal(h.enqueued[0].options.retryFailedTurn, true);
  // A user retry supersedes the automatic one.
  assert.equal(quotaResumeEntry(SESSION), null);
  await assert.rejects(h.bag.retryFailedTurn('sess_other', 'turn:u1'), /not the active session/);

  const media = harness(t, { items: failedTurn({ text: '', images: [{ token: 'img' }] }) });
  assert.equal(await media.bag.retryFailedTurn(SESSION, 'turn:u1'), false);
  assert.equal(media.enqueued.length, 0);
});

test("retryFailedTurn re-checks the session's own state when the deferred request arrives", async (t) => {
  // The reported race: the route reply already showed a running newer turn
  // while the renderer still looked idle on the stopped one.
  const newerTurn = [...failedTurn(), { id: 'u2', kind: 'user', text: 'something else' }];
  const running = harness(t, { items: newerTurn });
  running.patch({ busy: true });
  assert.equal(await running.bag.retryFailedTurn(SESSION, 'turn:u1'), false);
  assert.equal(running.enqueued.length, 0, 'the old prompt is not resubmitted');

  const completed = harness(t, {
    items: [
      ...newerTurn,
      { id: 'a2', kind: 'assistant', text: 'done' },
      { id: 'd2', kind: 'turndone', status: 'done' },
    ],
  });
  assert.equal(await completed.bag.retryFailedTurn(SESSION, 'turn:u1'), false);
  assert.equal(completed.enqueued.length, 0);

  // Still the latest failed turn, but something owns the session first.
  for (const block of [
    (h) => h.patch({ busy: true }),
    (h) => h.patch({ commandBusy: true }),
    (h) => h.pending.push({ id: 'queued', mode: 'prompt' }),
    (h) => {
      h.bag.flags.draining = true;
    },
  ]) {
    const h = harness(t);
    block(h);
    assert.equal(await h.bag.retryFailedTurn(SESSION, 'turn:u1'), false);
    assert.equal(h.enqueued.length, 0);
  }

  // Idle on that turn: retried once.
  const idle = harness(t);
  assert.equal(await idle.bag.retryFailedTurn(SESSION, 'turn:u1'), true);
  assert.equal(await idle.bag.retryFailedTurn(SESSION, 'turn:u0'), false, 'not the latest failed turn');
  assert.deepEqual(
    idle.enqueued.map((entry) => entry.text),
    ['build the parser']
  );
});

test('a fire revives only the Goal its failure suspended, before the retry, and queues one turn', async (t) => {
  let goal = { id: 'goal-1', sessionId: SESSION, objective: 'Ship it', status: 'usage_limited', tasks: [] };
  const goalListeners = new Set();
  const h = harness(t, {
    runtime: {
      goalStatus: () => goal,
      onGoalStatusChange(listener) {
        goalListeners.add(listener);
        return () => goalListeners.delete(listener);
      },
      reactivateUsageLimitedGoal: async (goalId, options = {}) => {
        h.calls.push(['reactivate', goalId]);
        if (options.isCurrent?.() === false || options.accept?.() === false) return null;
        if (goal.id === goalId && goal.status === 'usage_limited') goal = { ...goal, status: 'active' };
        for (const listener of goalListeners) listener({ sessionId: SESSION, goal });
        return goal;
      },
      goalContinuation: () =>
        goal.status === 'active'
          ? { run: true, reason: 'idle', goal, prompt: 'Continue the Goal.' }
          : { run: false, reason: goal.status, goal },
    },
  });
  // The drain starts the retry turn synchronously: the session is busy at once.
  const enqueue = h.bag.enqueue;
  h.bag.enqueue = (text, options) => {
    const accepted = enqueue(text, options);
    h.patch({ busy: true });
    return accepted;
  };
  const goalLane = createGoalContinuation({
    runtime: h.bag.runtime,
    flags: h.bag.flags,
    getState: h.bag.getState,
    set: h.bag.set,
    getPending: () => h.pending,
    enqueue: (...args) => h.bag.enqueue(...args),
  });
  t.after(() => goalLane.disposeGoalContinuation());

  const { generation } = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  // Waiting never revives the Goal.
  assert.equal(goal.status, 'usage_limited');
  assert.equal(await h.bag.fireQuotaResume({ generation }), 'fired');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(goal.status, 'active');
  assert.deepEqual(h.calls.slice(0, 2), [
    ['reactivate', 'goal-1'],
    ['enqueue', 'build the parser'],
  ]);
  assert.equal(h.enqueued.length, 1, 'the revived Goal queued no second turn');
  assert.equal(quotaSuspendedGoal(SESSION, 'turn:u1'), '');
});

test('a cancel that lands while the failed turn settles wins over the Goal note and every fire', async (t) => {
  const cancels = {
    'user input': (h) => createSubmissionIntake(h.bag).submit('do something else'),
  };
  for (const [name, cancel] of Object.entries(cancels)) {
    const h = harness(t, { runtime: { continueSessionInModel: async () => true } });
    // The failed turndone publishes with the resume already queued.
    const { generation } = h.bag.beginQuotaSettlement();
    assert.equal(h.state.quotaResume?.turnKey, 'turn:u1', name);
    // Nothing fires while the Goal settlement is still pending.
    assert.equal(h.bag.fireQuotaResume({ generation }), 'busy', name);
    await cancel(h);
    // The Goal settlement completes after the cancel and must not re-arm it.
    h.bag.finishQuotaSettlement({ suspendedGoalId: 'goal-1' });
    assert.equal(quotaResumeEntry(SESSION), null, name);
    assert.equal(h.state.quotaResume, null, name);
    assert.equal(quotaSuspendedGoal(SESSION, 'turn:u1'), '', name);
    assert.equal(h.bag.fireQuotaResume({ generation }), 'stale', name);
    assert.equal(
      h.enqueued.some((entry) => entry.options?.retryFailedTurn),
      false,
      name
    );
  }
});

function goalHarness(t, { items, goalStatus = 'usage_limited' } = {}) {
  let goal = { id: 'goal-1', sessionId: SESSION, objective: 'Ship it', status: goalStatus, tasks: [] };
  const goalListeners = new Set();
  const h = harness(t, {
    items,
    runtime: {
      goalStatus: () => goal,
      onGoalStatusChange(listener) {
        goalListeners.add(listener);
        return () => goalListeners.delete(listener);
      },
      reactivateUsageLimitedGoal: async (goalId, options = {}) => {
        h.calls.push(['reactivate', goalId]);
        if (options.isCurrent?.() === false || options.accept?.() === false) return null;
        if (goal.id === goalId && goal.status === 'usage_limited') goal = { ...goal, status: 'active' };
        for (const listener of goalListeners) listener({ sessionId: SESSION, goal });
        return goal;
      },
      goalContinuation: () =>
        goal.status === 'active'
          ? { run: true, reason: 'idle', goal, prompt: 'Continue the Goal.' }
          : { run: false, reason: goal.status, goal },
    },
  });
  // The drain starts a queued turn synchronously: the session is busy at once.
  const enqueue = h.bag.enqueue;
  h.bag.enqueue = (text, options) => {
    const accepted = enqueue(text, options);
    h.patch({ busy: true });
    return accepted;
  };
  const goalLane = createGoalContinuation({
    runtime: h.bag.runtime,
    flags: h.bag.flags,
    getState: h.bag.getState,
    set: h.bag.set,
    getPending: () => h.pending,
    enqueue: (...args) => h.bag.enqueue(...args),
  });
  Object.assign(h.bag, goalLane);
  t.after(() => goalLane.disposeGoalContinuation());
  return {
    h,
    get goal() {
      return goal;
    },
  };
}

// An automatic Goal turn: suppressed prompt, so no user row of its own.
const failedGoalTurn = () => [
  { id: 'u0', kind: 'user', text: 'earlier' },
  { id: 'd0', kind: 'turndone', status: 'done' },
  { id: 'n1', kind: 'notice', text: 'limit reached' },
  { id: 'd1', kind: 'turndone', status: 'failed', quota: quota() },
];

for (const first of ['manual', 'scheduled']) {
  test(`a reserved user turn resumes once when ${first} wins the race`, async (t) => {
    const h = harness(t);
    const { generation, turnKey } = h.bag.onQuotaTurnSettled();
    if (first === 'manual') {
      const retry = h.bag.retryFailedTurn(SESSION, turnKey);
      assert.equal(h.bag.fireQuotaResume({ generation }), 'stale');
      assert.equal(await retry, true);
    } else {
      assert.equal(h.bag.fireQuotaResume({ generation }), 'fired');
      assert.equal(await h.bag.retryFailedTurn(SESSION, turnKey), false);
    }
    assert.equal(h.enqueued.length, 1);
    assert.equal(quotaResumeEntry(SESSION), null);
  });
}

test('Goal activation failure preserves the reservation and suspension for another attempt', async (t) => {
  const h = harness(t, {
    runtime: {
      reactivateUsageLimitedGoal: async () => {
        throw new Error('storage unavailable');
      },
    },
  });
  const entry = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  await assert.rejects(h.bag.fireQuotaResume({ generation: entry.generation }), /storage unavailable/);
  assert.equal(quotaResumeEntry(SESSION).generation, entry.generation);
  assert.equal(quotaSuspendedGoal(SESSION, entry.turnKey), 'goal-1');
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.bag.flags.quotaResumePending, null);
});

test('a failed Goal rollback keeps execution fenced and reports the error', async (t) => {
  const h = harness(t, {
    runtime: {
      reactivateUsageLimitedGoal: async () => {
        throw Object.assign(new Error('Goal rollback failed'), { quotaResumeRollbackFailed: true });
      },
    },
  });
  const notices = [];
  h.bag.pushNotice = (...args) => notices.push(args);
  const entry = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  await assert.rejects(h.bag.fireQuotaResume({ generation: entry.generation }), /Goal rollback failed/);
  assert.ok(h.bag.flags.quotaResumePending);
  assert.equal(h.bag.fireQuotaResume({ generation: entry.generation }), 'busy');
  assert.equal(h.enqueued.length, 0);
  assert.match(notices[0][0], /Goal rollback failed/);
  assert.equal(quotaResumeEntry(SESSION).generation, entry.generation);
});

test('a user message arriving during Goal reactivation supersedes the resume before admission', async (t) => {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const h = harness(t, {
    runtime: {
      reactivateUsageLimitedGoal: async (_id, options) => {
        ready.resolve();
        await release.promise;
        if (!options.isCurrent() || !options.accept()) return null;
        return { status: 'active' };
      },
    },
  });
  const entry = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  const resume = h.bag.fireQuotaResume({ generation: entry.generation });
  await ready.promise;
  assert.ok(h.bag.flags.quotaResumePending);
  await createSubmissionIntake(h.bag).submitAsync('new instruction');
  release.resolve();
  assert.equal(await resume, 'rejected');
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(quotaSuspendedGoal(SESSION, entry.turnKey), '');
  assert.deepEqual(
    h.enqueued.map((row) => row.text),
    ['new instruction']
  );
});

test('a rejected Goal replay keeps its recovery data', async (t) => {
  const h = harness(t, {
    runtime: {
      reactivateUsageLimitedGoal: async (_id, options) =>
        options.isCurrent() && options.accept() ? { status: 'active' } : null,
    },
  });
  h.bag.enqueue = () => false;
  const entry = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  assert.equal(await h.bag.fireQuotaResume({ generation: entry.generation }), 'rejected');
  assert.equal(quotaResumeEntry(SESSION).generation, entry.generation);
  assert.equal(quotaSuspendedGoal(SESSION, entry.turnKey), 'goal-1');
});

test('immediate resume revives a failed Goal turn once without a user prompt', async (t) => {
  const g = goalHarness(t, { items: failedGoalTurn() });
  const { generation, turnKey } = g.h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  assert.equal(await g.h.bag.retryFailedTurn(SESSION, turnKey), true);
  assert.equal(g.h.bag.fireQuotaResume({ generation }), 'stale');
  assert.equal(await g.h.bag.retryFailedTurn(SESSION, turnKey), false);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(g.goal.status, 'active');
  assert.equal(g.h.enqueued.length, 1);
  assert.equal(g.h.enqueued[0].options.mode, 'goal-continuation');
  assert.equal(quotaResumeEntry(SESSION), null);
});

test('a failed Goal turn resumes as exactly one continuation of the revived Goal', async (t) => {
  const g = goalHarness(t, { items: failedGoalTurn() });
  const { generation, turnKey } = g.h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  assert.equal(turnKey, 'segment:n1');
  assert.equal(g.goal.status, 'usage_limited');
  assert.equal(await g.h.bag.fireQuotaResume({ generation }), 'fired');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(g.goal.status, 'active');
  assert.equal(g.h.enqueued.length, 1, 'one Goal turn');
  assert.equal(g.h.enqueued[0].options.mode, 'goal-continuation');
  assert.equal(g.h.enqueued[0].options.retryFailedTurn, undefined, 'no prompt replay');
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(g.h.state.quotaResume, null);
});

test('a failed Goal turn whose Goal was not suspended by it clears without a turn', async (t) => {
  for (const goalStatus of ['usage_limited', 'paused']) {
    const g = goalHarness(t, { items: failedGoalTurn(), goalStatus });
    const { generation } = g.h.bag.onQuotaTurnSettled();
    assert.equal(g.h.bag.fireQuotaResume({ generation }), 'unreplayable');
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(g.goal.status, goalStatus);
    assert.equal(g.h.enqueued.length, 0);
    assert.equal(quotaResumeEntry(SESSION), null);
  }
});

test('model changes preserve the reservation and resume on the current route', async (t) => {
  const route = { sessionProvider: 'openai-oauth', sessionModel: 'gpt-x' };
  const moved = harness(t, { runtime: { ...route } });
  const entry = moved.bag.onQuotaTurnSettled();
  assert.deepEqual([entry.routeProvider, entry.routeModel], ['openai-oauth', 'gpt-x']);
  moved.bag.runtime.sessionModel = 'gpt-y';
  assert.equal(moved.bag.fireQuotaResume({ generation: entry.generation }), 'fired');
  assert.equal(moved.enqueued.length, 1);
  assert.equal(quotaResumeEntry(SESSION), null);

  // The model picker keeps the same reservation and generation.
  const routed = harness(t, { runtime: { ...route, setRoute: async () => ({}) } });
  const routedEntry = routed.bag.onQuotaTurnSettled();
  const routesApi = createSessionRouteApi({
    ...routed.bag,
    flushEmitImmediate() {},
    routeState: () => ({}),
    syncContextStats() {},
    resetStats() {},
    resetStatsAndSyncContext() {},
  });
  assert.deepEqual(await routesApi.setRoute({ model: 'gpt-y' }), {});
  assert.equal(quotaResumeEntry(SESSION).generation, routedEntry.generation);
  assert.equal(routed.state.quotaResume.state, 'waiting');
  assert.equal(routed.bag.fireQuotaResume({ generation: routedEntry.generation }), 'fired');
});

test('clearing the session cancels its resume and clears the snapshot field', async (t) => {
  const h = harness(t, { runtime: { clear: async () => true } });
  h.patch({ stats: {}, toasts: [] });
  const { generation } = h.bag.onQuotaTurnSettled({ suspendedGoalId: 'goal-1' });
  const noop = () => {};
  const resets = createSessionResetActions({
    ...h.bag,
    flushEmitImmediate: noop,
    replaceItems: (items) => items,
    clearToastTimers: noop,
    routeState: () => ({}),
    clearUiActivityBeforeContextSync: noop,
    resetTuiForPendingSessionReset: noop,
    snapshotTuiBeforeSessionReset: () => ({}),
    restoreTuiAfterFailedSessionReset: noop,
    commitTuiSessionReset: noop,
    resetStatsAndSyncContext: noop,
  });
  assert.equal(await resets.clear(), true);
  assert.equal(quotaResumeEntry(SESSION), null);
  assert.equal(quotaSuspendedGoal(SESSION, 'turn:u1'), '');
  assert.equal(h.bag.fireQuotaResume({ generation }), 'stale');
  assert.equal(h.state.quotaResume, null);
});

test('Lead and agent sessions follow the same automatic resume option', async (t) => {
  for (const session of [
    { visibility: 'agent-only', owner: 'agent', agent: 'worker' },
    { owner: 'agent', agent: 'worker', parentSessionId: 'lead-1' },
    { owner: 'user', visibility: null },
  ]) {
    const h = harness(t, { runtime: { session } });
    const entry = h.bag.onQuotaTurnSettled();
    assert.equal(entry.turnKey, 'turn:u1');
    assert.equal(h.bag.fireQuotaResume({ generation: entry.generation }), 'fired');
    assert.equal(h.enqueued.length, 1);
    setQuotaAutoResumeEnabled(false);
    assert.equal(h.bag.onQuotaTurnSettled(), null);
    assert.equal(quotaResumeEntry(SESSION), null);
  }
});

test('a fire without a suspended Goal revives none', (t) => {
  const reactivated = [];
  const h = harness(t, { runtime: { reactivateUsageLimitedGoal: (id) => reactivated.push(id) } });
  const { generation } = h.bag.onQuotaTurnSettled();
  assert.equal(h.bag.fireQuotaResume({ generation }), 'fired');
  assert.deepEqual(reactivated, []);
});
