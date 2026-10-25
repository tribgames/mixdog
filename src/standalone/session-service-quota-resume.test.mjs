import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as quotaResumeStore from '../runtime/shared/quota-resume-store.mjs';
import { ModelProxyUnavailableError } from '../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { createQuotaResumeLane } from '../tui/session/quota-resume.mjs';
import { createSessionService } from './session-service.mjs';
import {
  QUOTA_RESUME_BUSY_RECHECK_MS,
  QUOTA_RESUME_RETRY_MS,
  createQuotaResumeScheduler,
} from './session-service/quota-resume.mjs';

const SESSION = 'sess_quota_resume_restart';
const PAST = Date.now() - 60_000;

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-resume-service-'));
  const overrides = { MIXDOG_DATA_DIR: dir, MIXDOG_CONFIG_DIR: dir, MIXDOG_SKIP_USER_DATA_BACKUP: '1' };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  quotaResumeStore.reloadQuotaResumeStore();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    quotaResumeStore.reloadQuotaResumeStore();
    rmSync(dir, { recursive: true, force: true });
  });
}

const storedTranscript = (sessionId) => ({
  sessionId,
  provider: 'openai-oauth',
  model: 'gpt-x',
  queued: [],
  items: [
    { id: 'u1', kind: 'user', text: 'finish the migration' },
    {
      id: 'd1',
      kind: 'turndone',
      status: 'failed',
      quota: { provider: 'openai-oauth', model: 'gpt-x', resetAt: PAST },
    },
  ],
});

// A session runtime whose quota lane is the real one; only the queue is a
// recorder (the drain would start the retry turn here).
function runtimeFactory({ storedSessions, created, retries }) {
  return async () => {
    created.push(true);
    const listeners = new Set();
    let state = { sessionId: '', items: [], queued: [], busy: false, commandBusy: false };
    const bag = {
      runtime: {},
      flags: { admission: 'open', disposed: false },
      pending: [],
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
      },
      nextId: () => `retry-${retries.length + 1}`,
      enqueue: (text, options) => {
        retries.push({ sessionId: state.sessionId, text, options });
        return true;
      },
    };
    Object.assign(bag, createQuotaResumeLane(bag));
    return {
      isWireSafe: true,
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async resume(sessionId) {
        const stored = storedSessions.get(sessionId);
        if (!stored) return false;
        bag.set({ ...stored, sessionId });
        bag.publishQuotaResume();
        return true;
      },
      fireQuotaResume: (options) => bag.fireQuotaResume(options),
      async dispose() {
        bag.disposeQuotaResume();
      },
    };
  };
}

function service({ storedSessions, created, retries, readings }) {
  return createSessionService({
    createSessionRuntime: runtimeFactory({ storedSessions, created, retries }),
    sessionExists: async (sessionId) => storedSessions.has(sessionId),
    readStoredSession: async (sessionId) => storedSessions.get(sessionId) || null,
    quotaResumeStore,
    readQuotaUsable: async (provider, model) => {
      readings.push([provider, model]);
      return readings.usable;
    },
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
}

for (const oldRouteUsable of [true, false]) {
  test(`a model switch during quota lookup ignores the old result (${oldRouteUsable})`, async (t) => {
    isolateDataDir(t);
    let clock = PAST + 1000;
    let route = { sessionProvider: 'openai-oauth', sessionModel: 'gpt-x' };
    const readings = [];
    const fired = [];
    const scheduler = createQuotaResumeScheduler({
      store: quotaResumeStore,
      materializeSession: async () => ({
        getState: () => route,
        fireQuotaResume: (options) => {
          fired.push(options);
          return 'fired';
        },
      }),
      readQuotaUsable: async (provider, model) => {
        readings.push([provider, model]);
        if (readings.length === 1) {
          route = { sessionProvider: 'anthropic-oauth', sessionModel: 'claude-new' };
          return oldRouteUsable;
        }
        return true;
      },
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const entry = quotaResumeStore.scheduleQuotaResumeEntry({
      sessionId: SESSION,
      turnKey: 'turn:u1',
      provider: 'openai-oauth',
      model: 'gpt-x',
      resetAt: PAST,
    });
    await scheduler.tick();
    assert.deepEqual(fired, []);
    const pending = quotaResumeStore.quotaResumeEntry(SESSION);
    assert.equal(pending.generation, entry.generation);
    assert.equal(pending.attempts, 0);
    assert.equal(pending.resetAt, clock + QUOTA_RESUME_BUSY_RECHECK_MS);
    clock = pending.resetAt;
    await scheduler.tick();
    assert.deepEqual(readings, [
      ['openai-oauth', 'gpt-x'],
      ['anthropic-oauth', 'claude-new'],
    ]);
    assert.deepEqual(fired, [{ generation: entry.generation }]);
  });
}

test('failed asynchronous resume keeps and defers the same reservation', async (t) => {
  isolateDataDir(t);
  const clock = PAST + 1000;
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async () => ({
      fireQuotaResume: async () => {
        throw new Error('Goal storage failed');
      },
    }),
    readQuotaUsable: async () => true,
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  const entry = quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'segment:n1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  await scheduler.tick();
  const pending = quotaResumeStore.quotaResumeEntry(SESSION);
  assert.equal(pending.generation, entry.generation);
  assert.equal(pending.resetAt, clock + QUOTA_RESUME_RETRY_MS);
});

test('a persisted reservation checks the current model after a route change', async (t) => {
  isolateDataDir(t);
  const readings = [];
  const fired = [];
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async () => ({
      getState: () => ({ sessionProvider: 'anthropic-oauth', sessionModel: 'claude-new' }),
      fireQuotaResume: (options) => {
        fired.push(options);
        return 'fired';
      },
    }),
    readQuotaUsable: async (...route) => {
      readings.push(route);
      return true;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  const entry = quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  quotaResumeStore.reloadQuotaResumeStore();
  await scheduler.tick();
  assert.deepEqual(readings, [['anthropic-oauth', 'claude-new']]);
  assert.deepEqual(fired, [{ generation: entry.generation }]);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
});

test('a deferred route selection is the route checked, and a selection change during the check is noticed', async (t) => {
  isolateDataDir(t);
  let clock = PAST + 1000;
  let selected = { provider: 'anthropic-oauth', model: 'claude-new' };
  const readings = [];
  const fired = [];
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async () => ({
      getState: () => ({
        sessionProvider: 'openai-oauth',
        sessionModel: 'gpt-x',
        provider: selected.provider,
        model: selected.model,
      }),
      fireQuotaResume: (options) => {
        fired.push(options);
        return 'fired';
      },
    }),
    readQuotaUsable: async (provider, model) => {
      readings.push([provider, model]);
      if (readings.length === 1) selected = { provider: 'google-oauth', model: 'gemini-new' };
      return true;
    },
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  const entry = quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  await scheduler.tick();
  assert.deepEqual(fired, []);
  const pending = quotaResumeStore.quotaResumeEntry(SESSION);
  assert.equal(pending.generation, entry.generation);
  assert.equal(pending.attempts, 0);
  clock = pending.resetAt;
  await scheduler.tick();
  assert.deepEqual(readings, [
    ['anthropic-oauth', 'claude-new'],
    ['google-oauth', 'gemini-new'],
  ]);
  assert.deepEqual(fired, [{ generation: entry.generation }]);
});

test('an overdue resume runs after a daemon restart with the session unloaded', async (t) => {
  isolateDataDir(t);
  const storedSessions = new Map([[SESSION, storedTranscript(SESSION)]]);
  const created = [];
  const retries = [];
  const readings = Object.assign([], { usable: true });

  // First daemon: the failure was queued, then the daemon went away.
  const first = service({ storedSessions, created, retries, readings });
  quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  await first.stop('daemon replaced');
  quotaResumeStore.reloadQuotaResumeStore();

  // Second daemon: nothing is loaded, the cold view already shows the wait.
  const second = service({ storedSessions, created, retries, readings });
  t.after(() => second.stop('test complete'));
  const cold = await second.subscribeSession({ sessionId: SESSION }, { clientToken: 'viewer' });
  assert.equal(cold.projection, true);
  assert.deepEqual(cold.full.quotaResume, {
    state: 'waiting',
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
    attempts: 0,
  });
  assert.equal(created.length, 0);

  second.startQuotaResume();
  await new Promise((resolve) => setImmediate(resolve));
  await second.runDueQuotaResumes();

  assert.equal(created.length, 1, 'the addressed session was materialized');
  assert.deepEqual(readings.slice(), [['openai-oauth', 'gpt-x']], 'one fresh usage reading before firing');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].sessionId, SESSION);
  assert.equal(retries[0].text, 'finish the migration');
  assert.equal(retries[0].options.retryFailedTurn, true);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
});

test('a still-exhausted reading retries once five minutes later, persisted, then clears', async (t) => {
  isolateDataDir(t);
  const storedSessions = new Map([[SESSION, storedTranscript(SESSION)]]);
  const retries = [];
  const readings = Object.assign([], { usable: false });
  const created = [];
  let clock = 1_000_000;
  const materialized = [];
  const makeScheduler = () =>
    createQuotaResumeScheduler({
      store: quotaResumeStore,
      materializeSession: async (sessionId) => {
        materialized.push(sessionId);
        const runtime = await runtimeFactory({ storedSessions, created, retries })();
        await runtime.resume(sessionId);
        return runtime;
      },
      readQuotaUsable: async (provider, model) => {
        readings.push([provider, model]);
        return readings.usable;
      },
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
    });
  quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: clock,
  });
  await makeScheduler().tick();
  const deferred = quotaResumeStore.quotaResumeEntry(SESSION);
  assert.equal(deferred.attempts, 1);
  assert.equal(deferred.resetAt, clock + QUOTA_RESUME_RETRY_MS);
  assert.equal(retries.length, 0);

  // Restart before the re-check: the attempt count survives.
  quotaResumeStore.reloadQuotaResumeStore();
  const restarted = makeScheduler();
  clock += QUOTA_RESUME_RETRY_MS - 1;
  await restarted.tick();
  assert.equal(readings.length, 1, 'not due yet');
  clock += 1;
  await restarted.tick();
  assert.equal(readings.length, 2);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null, 'the wait is cleared');
  assert.equal(retries.length, 0, 'nothing fired');
});

for (const attempts of [0, 1]) {
  test(`a disconnected PC preserves a quota resume with ${attempts} spent attempts until reconnection`, async (t) => {
    isolateDataDir(t);
    let clock = PAST + 1000;
    let connected = false;
    const fired = [];
    const scheduler = createQuotaResumeScheduler({
      store: quotaResumeStore,
      materializeSession: async () => ({
        fireQuotaResume: (options) => {
          fired.push(options);
          return 'fired';
        },
      }),
      readQuotaUsable: async () => {
        if (!connected) throw new ModelProxyUnavailableError('PC disconnected');
        return true;
      },
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const entry = quotaResumeStore.scheduleQuotaResumeEntry({
      sessionId: SESSION,
      turnKey: 'turn:u1',
      provider: 'openai-oauth',
      model: 'gpt-x',
      resetAt: clock,
    });
    quotaResumeStore.deferQuotaResumeEntry(SESSION, entry.generation, { resetAt: clock, attempts });
    for (let check = 0; check < 3; check += 1) {
      await scheduler.tick();
      const pending = quotaResumeStore.quotaResumeEntry(SESSION);
      assert.equal(pending?.generation, entry.generation);
      assert.equal(pending.attempts, attempts);
      assert.equal(pending.resetAt, clock + QUOTA_RESUME_RETRY_MS);
      assert.deepEqual(fired, []);
      quotaResumeStore.reloadQuotaResumeStore();
      clock = pending.resetAt;
    }
    connected = true;
    await scheduler.tick();
    assert.deepEqual(fired, [{ generation: entry.generation }]);
    assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
  });
}

test('a usable re-check fires, and a busy session is re-checked without spending an attempt', async (t) => {
  isolateDataDir(t);
  const storedSessions = new Map([[SESSION, storedTranscript(SESSION)]]);
  const retries = [];
  const readings = Object.assign([], { usable: true });
  let clock = 5_000_000;
  let busy = true;
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async (sessionId) => {
      const runtime = await runtimeFactory({ storedSessions, created: [], retries })();
      await runtime.resume(sessionId);
      const fire = runtime.fireQuotaResume;
      return { ...runtime, fireQuotaResume: (options) => (busy ? 'busy' : fire(options)) };
    },
    readQuotaUsable: async () => readings.usable,
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: clock,
  });
  await scheduler.tick();
  const waiting = quotaResumeStore.quotaResumeEntry(SESSION);
  assert.equal(waiting.attempts, 0);
  assert.equal(waiting.resetAt, clock + QUOTA_RESUME_BUSY_RECHECK_MS);
  assert.equal(retries.length, 0);
  busy = false;
  clock += QUOTA_RESUME_BUSY_RECHECK_MS;
  await scheduler.tick();
  assert.equal(retries.length, 1);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
});

test('a persisted agent reservation fires under the same policy as a Lead reservation', async (t) => {
  isolateDataDir(t);
  const fired = [];
  let readings = 0;
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async () => ({
      session: { id: SESSION, visibility: 'agent-only', owner: 'agent', agent: 'worker' },
      fireQuotaResume: (options) => fired.push(options),
    }),
    readQuotaUsable: async () => {
      readings += 1;
      return true;
    },
    setTimer: () => null,
    clearTimer: () => {},
  });
  const entry = quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  await scheduler.tick();
  assert.deepEqual(fired, [{ generation: entry.generation }]);
  assert.equal(readings, 1);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
});

test('a cancel landing during the usage reading prevents the fire', async (t) => {
  isolateDataDir(t);
  const storedSessions = new Map([[SESSION, storedTranscript(SESSION)]]);
  const retries = [];
  const reading = Promise.withResolvers();
  const scheduler = createQuotaResumeScheduler({
    store: quotaResumeStore,
    materializeSession: async (sessionId) => {
      const runtime = await runtimeFactory({ storedSessions, created: [], retries })();
      await runtime.resume(sessionId);
      return runtime;
    },
    readQuotaUsable: () => reading.promise,
    setTimer: () => null,
    clearTimer: () => {},
  });
  quotaResumeStore.scheduleQuotaResumeEntry({
    sessionId: SESSION,
    turnKey: 'turn:u1',
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: PAST,
  });
  const run = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  quotaResumeStore.cancelQuotaResumeEntry(SESSION);
  reading.resolve(true);
  await run;
  assert.equal(retries.length, 0);
  assert.equal(quotaResumeStore.quotaResumeEntry(SESSION), null);
});
