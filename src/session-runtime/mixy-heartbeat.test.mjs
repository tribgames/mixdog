import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createHeartbeatCompletion,
  parseHeartbeatDecision,
} from '../runtime/agent/orchestrator/agent-runtime/heartbeat-completion.mjs';
import { createNoticeSurface } from '../tui/session/notice-surface.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import { isHeartbeatSession } from '../runtime/shared/routine-trigger.mjs';
import { unattendedRunOf } from './held-requests.mjs';
import {
  HEARTBEAT_LIMITS,
  collectHeartbeatFacts,
  composeDigest,
  createMixyHeartbeat,
  isQuietReply,
  recordSuggestion,
  startMixyHeartbeat,
  wakeMixy,
} from './mixy-heartbeat.mjs';
import { createSettingsApi } from './settings-api.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 0, 1, 9);
const INTERVAL = HEARTBEAT_LIMITS.intervalMs;
const HOME = 'sess_home_lead';

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const facts = (extra = {}) => ({ sessions: [], tasks: [], approvals: 0, routines: [], ...extra });
const activity = facts({ sessions: [{ id: 'sess_lead_1', bot: '', title: 'Report', preview: 'Draft done' }] });
const failing = (failures, enabled = true) =>
  facts({ routines: [{ kind: 'schedule', name: 'daily-news', enabled, failures }] });
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** A heartbeat over fakes: clock, stores, Maintainer and Mixy's wake. */
function harness(t, { state: initial = {}, decide = () => ({ action: 'nothing' }), wake = null } = {}) {
  const path = join(tempDir(t), 'heartbeat.json');
  let clock = T0;
  const state = { facts: activity, routeKey: 'fake/tiny/', enabled: true, userTurnAt: 0, ...initial };
  const calls = { collect: [], decide: [], wake: [], notify: [], logs: [] };
  const build = (overrides = {}) =>
    createMixyHeartbeat({
      now: () => clock,
      path,
      isEnabled: async () => state.enabled,
      userTurnAt: () => state.userTurnAt,
      collect: async (input) => {
        calls.collect.push(input);
        if (typeof state.facts === 'function') return state.facts(input);
        return structuredClone(state.facts);
      },
      routeKey: async () => state.routeKey,
      decide: async (input) => {
        calls.decide.push(input);
        return decide(input);
      },
      wake: async (input, hooks) => {
        calls.wake.push(input);
        return wake ? wake(input, hooks) : { quiet: false };
      },
      notify: async (text) => calls.notify.push(text),
      log: (line) => calls.logs.push(line),
      ...overrides,
    });
  let heartbeat = build();
  return {
    tick: () => heartbeat.tick(),
    /** A daemon restart: a new heartbeat over the same state file. */
    restart: (overrides) => {
      heartbeat = build(overrides);
    },
    calls,
    state,
    path,
    at: () => clock,
    advance: (ms = INTERVAL) => (clock += ms),
    /** Arm at T0 and move to the first due check. */
    async arm() {
      assert.equal(await heartbeat.tick(), 'armed');
      clock += INTERVAL;
    },
  };
}

test('an unchanged digest makes no Maintainer call; its "nothing" wakes no one; an empty digest stops too', async (t) => {
  const h = harness(t);
  await h.arm();
  assert.equal(await h.tick(), 'nothing');
  assert.equal(h.calls.decide.length, 1);
  h.advance();
  assert.equal(await h.tick(), 'unchanged');
  h.state.facts = facts();
  h.advance();
  assert.equal(await h.tick(), 'empty');
  assert.equal(h.calls.decide.length, 1, 'only the first, new digest reached the Maintainer');
  assert.equal(h.calls.wake.length, 0);
});

test('a wake decision wakes Mixy once with its items and the open and declined proposal keys', async (t) => {
  const h = harness(t, { decide: () => ({ action: 'wake', items: ['The report draft is ready'] }) });
  recordSuggestion({ key: 'create-routine:weekly-review', text: 'A weekly review' }, { path: h.path, now: h.at });
  recordSuggestion({ key: 'pause-routine:old-news', dismissed: true }, { path: h.path, now: h.at });
  await h.arm();
  assert.equal(await h.tick(), 'woke');
  const expected = { proposals: ['create-routine:weekly-review'], dismissed: ['pause-routine:old-news'] };
  assert.deepEqual(h.calls.wake, [{ items: ['The report draft is ready'], ...expected }]);
  assert.match(h.calls.decide[0].digest[0], /^new activity in sess_lead_1: "Report", last: "Draft done"$/);
  assert.deepEqual({ proposals: h.calls.decide[0].proposals, dismissed: h.calls.decide[0].dismissed }, expected);
});

/** Mixy's sessions behind the real home delivery: the session service creates
 *  her hidden session, its turn settles with `reply`, and the home chat is a
 *  stored session the real queue posts into. */
function mixySessions(t, reply) {
  const dir = tempDir(t);
  const created = [];
  const submitted = [];
  const released = [];
  const runs = [];
  const notices = [];
  const saved = [];
  const home = { id: HOME, messages: [{ role: 'user', content: 'hello' }] };
  const queue = createRoutineResultQueue(join(dir, 'routine-results.json'));
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => (id === HOME ? home : null),
    saveSession: async (session) => saved.push(structuredClone(session)),
    turnInFlight: () => false,
    queue,
    live: () => ({
      busy: () => false,
      notice: (sessionId, notice) => notices.push([sessionId, notice]),
    }),
    retryLater: () => {},
    log: () => {},
  });
  const service = {
    createSession: async (params) => {
      created.push(params);
      return { sessionId: 'sess_daemon_heartbeat1' };
    },
  };
  const surface = {
    submit: async (sessionId, content, options) => {
      submitted.push({ sessionId, content: String(content), options });
      queueMicrotask(() => {
        options.onCommitted?.();
        runs.push(unattendedRunOf(sessionId));
        options.onSettled?.(
          reply === null ? { status: 'failed', error: 'provider down' } : { status: 'done', result: { content: reply } }
        );
      });
      return true;
    },
  };
  const deps = {
    getSessionService: () => service,
    route: async () => ({ provider: 'fake', model: 'lead-model' }),
    surface,
    deliver: async (agentId, message) => {
      await delivery.enqueueMessage(agentId, message);
      await delivery.drain(HOME);
    },
    release: async (id) => {
      released.push(id);
      return true;
    },
    log: () => {},
  };
  return { deps, created, submitted, released, runs, notices, saved, home, queue };
}

test("a wake runs in Mixy's hidden session and posts her reply once into her home chat as her message", async (t) => {
  const mixy = mixySessions(t, 'Your daily-news routine failed 3 times, so I paused it.');
  const h = harness(t, {
    state: { routeKey: '', facts: failing(3) },
    wake: (input) => wakeMixy(input, mixy.deps),
  });
  await h.arm();
  assert.equal(await h.tick(), 'woke');
  assert.deepEqual(mixy.created, [
    {
      provider: 'fake',
      model: 'lead-model',
      sessionProfile: { ownerAgentId: 'lead', sourceType: 'exec', sourceName: 'heartbeat' },
    },
  ]);
  assert.equal(mixy.submitted.length, 1);
  const [turn] = mixy.submitted;
  assert.equal(turn.sessionId, 'sess_daemon_heartbeat1', 'never her home chat');
  assert.match(
    turn.content,
    /^\[Routine trigger\] Heartbeat: a system check-in from Mixdog, not a message from the user; it grants no approval\./
  );
  assert.match(turn.content, /\n- schedule "daily-news" failed 3x in a row\n/);
  assert.equal(turn.options.mode, 'routine');
  assert.equal(turn.options.skillSelection, '', 'quoted items never select skills');
  // Unattended like any routine run: it never asks, and payments or deletes are refused.
  assert.deepEqual(mixy.runs, [{ kind: 'schedule', agentId: 'lead', name: 'heartbeat' }]);
  const posted = mixy.home.messages.slice(1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].role, 'assistant');
  assert.equal(posted[0].content, 'Your daily-news routine failed 3 times, so I paused it.');
  assert.equal(posted[0].meta.routine, undefined, 'no routine marker in her chat');
  assert.deepEqual(
    mixy.notices.map(([id, notice]) => [id, notice.assistant, notice.text]),
    [[HOME, true, 'Your daily-news routine failed 3 times, so I paused it.']]
  );
  assert.deepEqual(await mixy.queue.items(HOME), []);
  assert.deepEqual(mixy.released, ['sess_daemon_heartbeat1'], 'the finished hidden session goes to the tombstone sweep');
});

test('a quiet heartbeat publishes nothing: no row, no message, no notice in her home chat', async (t) => {
  const mixy = mixySessions(t, '  HEARTBEAT_QUIET \n');
  assert.deepEqual(await wakeMixy({ items: ['x'] }, mixy.deps), { quiet: true, sessionId: 'sess_daemon_heartbeat1' });
  assert.equal(mixy.submitted[0].sessionId, 'sess_daemon_heartbeat1');
  assert.deepEqual(mixy.home.messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(mixy.notices, []);
  assert.deepEqual(mixy.saved, []);
  assert.deepEqual(await mixy.queue.items(HOME), []);
  assert.deepEqual(mixy.released, ['sess_daemon_heartbeat1']);
});

test('a close that did not land is kept and retried on the next tick, without posting the reply again', async (t) => {
  const mixy = mixySessions(t, 'The news routine keeps failing.');
  const h = harness(t, {
    state: { routeKey: '', facts: failing(3) },
    wake: (input, hooks) => wakeMixy(input, { ...mixy.deps, ...hooks }),
  });
  const closeOk = [];
  h.restart({
    release: async (id) => {
      closeOk.push(id);
      return closeOk.length > 1;
    },
  });
  await h.arm();
  assert.equal(await h.tick(), 'woke');
  assert.deepEqual(readJson(h.path).unreleased, ['sess_daemon_heartbeat1']);
  assert.equal(isHeartbeatSession('sess_daemon_heartbeat1'), true, 'still a heartbeat session until it closes');
  assert.equal(await h.tick(), 'waiting');
  assert.deepEqual(closeOk, ['sess_daemon_heartbeat1', 'sess_daemon_heartbeat1']);
  assert.deepEqual(readJson(h.path).unreleased, []);
  assert.equal(isHeartbeatSession('sess_daemon_heartbeat1'), false);
  assert.equal(mixy.home.messages.length, 2, 'the reply was posted once');
  assert.equal(mixy.submitted.length, 1);
});

test('a full list of unclosed hidden sessions starts no new check and keeps every id', async (t) => {
  const h = harness(t, { state: { routeKey: '', facts: failing(3) } });
  const ids = Array.from({ length: 20 }, (_, i) => `sess_daemon_left${i}`);
  writeFileSync(h.path, JSON.stringify({ unreleased: ids }));
  h.restart({ release: async () => false });
  await h.arm();
  assert.equal(await h.tick(), 'blocked');
  assert.equal(h.calls.decide.length + h.calls.wake.length, 0);
  assert.deepEqual(readJson(h.path).unreleased, ids);
});

test('a hidden heartbeat session whose turn failed is released too', async (t) => {
  const mixy = mixySessions(t, null);
  await assert.rejects(wakeMixy({ items: ['x'] }, mixy.deps), /provider down/);
  assert.deepEqual(mixy.released, ['sess_daemon_heartbeat1']);
  assert.deepEqual(mixy.home.messages, [{ role: 'user', content: 'hello' }]);
});

test("the live view shows a posted agent message as the agent's reply row", () => {
  const items = [];
  const surface = createNoticeSurface({
    getState: () => ({ items, toasts: [] }),
    set: () => {},
    isDisposed: () => false,
    pushItem: (item) => items.push(item),
    replaceItems: (rows) => rows,
  });
  surface.pushNotice('Line one\nline two', 'info', { transcript: true, assistant: true, messageId: 'routine_x' });
  assert.equal(items.length, 1);
  assert.deepEqual(
    { kind: items[0].kind, id: items[0].id, text: items[0].text, messageId: items[0].messageId },
    { kind: 'assistant', id: 'routine_x', text: 'Line one\nline two', messageId: 'routine_x' }
  );
});

test('a failed collection keeps the watermark for the next check, which is not retried at once', async (t) => {
  let broken = true;
  const h = harness(t, {
    state: {
      facts: () => {
        if (broken) throw new Error('catalog unavailable');
        return structuredClone(activity);
      },
    },
  });
  await h.arm();
  assert.equal(await h.tick(), 'failed');
  assert.equal(await h.tick(), 'waiting', 'a failed check waits for the next interval');
  broken = false;
  h.advance();
  assert.equal(await h.tick(), 'nothing');
  assert.deepEqual(
    h.calls.collect.map((input) => input.since),
    [T0, T0],
    'the second check still collects since the last handled one'
  );
  assert.equal(readJson(h.path).lastBeatAt, T0 + 2 * INTERVAL);
});

test('a rejected wake keeps the digest and the routine report for the next check', async (t) => {
  let reject = true;
  const h = harness(t, {
    state: { routeKey: '', facts: failing(3) },
    wake: () => {
      if (reject) throw new Error('no Lead model is chosen');
      return { quiet: false };
    },
  });
  await h.arm();
  assert.equal(await h.tick(), 'failed');
  const kept = readJson(h.path);
  assert.equal(kept.lastBeatAt, T0);
  assert.equal(kept.lastHash, '');
  assert.deepEqual(kept.routines, {});
  reject = false;
  h.advance();
  assert.equal(await h.tick(), 'woke', 'the same routine failure wakes again');
  assert.deepEqual(
    h.calls.wake.map((input) => input.items),
    [['schedule "daily-news" failed 3x in a row'], ['schedule "daily-news" failed 3x in a row']]
  );
  assert.deepEqual(Object.keys(readJson(h.path).routines), ['schedule:daily-news']);
  h.advance();
  assert.equal(await h.tick(), 'empty');
});

test('with the Maintainer off, only a routine failing 3 times in a row wakes Mixy', async (t) => {
  const h = harness(t, { state: { routeKey: '', facts: activity } });
  await h.arm();
  assert.equal(await h.tick(), 'quiet', 'activity alone wakes no one');
  h.state.facts = failing(2);
  h.advance();
  assert.equal(await h.tick(), 'quiet');
  h.state.facts = failing(3);
  h.advance();
  assert.equal(await h.tick(), 'woke');
  assert.deepEqual(h.calls.wake[0].items, ['schedule "daily-news" failed 3x in a row']);
  assert.equal(h.calls.decide.length, 0, 'no model is asked');
});

test('a failing routine is reported once, then every 6 hours, once when it switches itself off; success closes it', async (t) => {
  const h = harness(t, { state: { routeKey: '', facts: failing(3) } });
  await h.arm();
  const step = async (next, outcome) => {
    h.state.facts = next;
    assert.equal(await h.tick(), outcome);
    h.advance();
  };
  await step(failing(3), 'woke');
  await step(failing(4), 'empty');
  await step(failing(4), 'unchanged');
  await step(failing(4), 'woke'); // 6 hours after the first report
  await step(failing(5, false), 'woke'); // switched itself off
  await step(failing(5, false), 'empty');
  await step(failing(0), 'unchanged'); // success closes it
  assert.deepEqual(readJson(h.path).routines, {});
  await step(failing(3), 'woke');
  assert.deepEqual(
    h.calls.wake.map((input) => input.items[0]),
    [
      'schedule "daily-news" failed 3x in a row',
      'schedule "daily-news" failed 4x in a row',
      'schedule "daily-news" failed 5x in a row and switched itself off',
      'schedule "daily-news" failed 3x in a row',
    ]
  );
});

test('malformed WAKE replies are parse failures: the breaker trips after 3, with one log line and one notice', async (t) => {
  const h = harness(t, { decide: () => parseHeartbeatDecision('WAKE\n- the report is ready\nstray line') });
  await h.arm();
  for (const outcome of ['retry', 'retry', 'retry', 'quiet']) {
    assert.equal(await h.tick(), outcome);
    h.advance();
  }
  assert.equal(h.calls.decide.length, 3, 'the fourth check skips the Maintainer and applies the routine rule');
  assert.equal(h.calls.wake.length, 0);
  assert.equal(h.calls.notify.length, 1);
  assert.match(h.calls.notify[0], /3 unusable replies in a row/);
  assert.equal(h.calls.logs.filter((line) => /gate off/.test(line)).length, 1);
  h.state.routeKey = 'fake/other/';
  h.state.facts = facts({ approvals: 1 });
  assert.equal(await h.tick(), 'retry');
  assert.equal(h.calls.decide.length, 4, 'a Maintainer change resets the breaker');
});

test('the breaker trips after 5 provider failures; meanwhile a failing routine still wakes Mixy', async (t) => {
  const h = harness(t, {
    decide: () => {
      throw new Error('503 overloaded');
    },
  });
  await h.arm();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await h.tick(), 'retry');
    h.advance();
  }
  assert.equal(h.calls.notify.length, 1);
  assert.match(h.calls.notify[0], /5 failed calls in a row/);
  h.state.facts = failing(3);
  assert.equal(await h.tick(), 'woke');
  assert.equal(h.calls.decide.length, 5);
});

test("a routine wake after a failed Maintainer call commits only the routine warning, not the changes it never judged", async (t) => {
  let down = true;
  const h = harness(t, {
    state: { facts: facts({ ...failing(3), sessions: activity.sessions }) },
    decide: () => {
      if (down) throw new Error('503 overloaded');
      return { action: 'wake', items: ['The report draft is ready'] };
    },
  });
  await h.arm();
  assert.equal(await h.tick(), 'woke');
  assert.deepEqual(h.calls.wake[0].items, ['schedule "daily-news" failed 3x in a row']);
  const kept = readJson(h.path);
  assert.equal(kept.lastBeatAt, T0, 'the watermark stays for the session activity');
  assert.equal(kept.lastHash, '');
  assert.deepEqual(Object.keys(kept.routines), ['schedule:daily-news']);
  down = false;
  h.advance();
  assert.equal(await h.tick(), 'woke');
  assert.equal(h.calls.collect[1].since, T0);
  assert.deepEqual(h.calls.decide[1].digest, ['new activity in sess_lead_1: "Report", last: "Draft done"']);
  assert.deepEqual(h.calls.wake[1].items, ['The report draft is ready'], 'the routine was told once');
});

test('collection fails when any source fails: task watches, held requests, routines or the catalog', async () => {
  const service = {
    listSessionCatalog: async () => ({ sessions: [{ id: 'sess_lead_a', lastUsedAt: T0 + MINUTE }], nextCursor: null }),
  };
  const ok = {
    since: T0,
    now: T0 + INTERVAL,
    getSessionService: () => service,
    routines: async () => [],
    heldRequests: async () => [],
    taskWatches: async () => [],
  };
  assert.equal((await collectHeartbeatFacts(ok)).sessions.length, 1);
  const broken = async () => {
    throw new Error('EIO: read failed');
  };
  for (const source of ['taskWatches', 'heldRequests', 'routines']) {
    await assert.rejects(collectHeartbeatFacts({ ...ok, [source]: broken }), /EIO/, source);
  }
  // The real task-watch source over a queue file that cannot be read.
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-queue-'));
  try {
    const queue = createRoutineResultQueue(dir);
    await assert.rejects(collectHeartbeatFacts({ ...ok, taskWatches: () => queue.watches() }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(
    collectHeartbeatFacts({ ...ok, getSessionService: () => ({ listSessionCatalog: broken }) }),
    /EIO/
  );
});

test('a due check waits while the user is active; missed checks run as one; two never overlap', async (t) => {
  const h = harness(t);
  await h.arm();
  h.state.userTurnAt = h.at() - 5 * MINUTE;
  assert.equal(await h.tick(), 'deferred');
  assert.equal(h.calls.collect.length, 0);
  h.state.userTurnAt = h.at() - 11 * MINUTE;
  h.advance(10 * INTERVAL);
  const [first, second] = await Promise.all([h.tick(), h.tick()]);
  assert.deepEqual([first, second], ['nothing', 'running']);
  assert.equal(await h.tick(), 'waiting', 'the missed checks were one');
  assert.equal(h.calls.collect.length, 1);
  assert.equal(h.calls.collect[0].since, T0, 'it covers everything since the last check');
});

test("after a restart the session store's record of the user's activity still makes a due check wait", async (t) => {
  const h = harness(t);
  await h.arm();
  const recent = h.at() - 3 * MINUTE;
  const rows = [
    { id: 'sess_lead_a', owner: 'cli', sourceType: 'lead', sourceName: 'main', lastUsedAt: recent },
    { id: 'sess_t1', sourceName: 'agent:reviewer@home', lastUsedAt: h.at() - MINUTE },
    { id: 'sess_x', sourceType: 'exec', sourceName: 'heartbeat', lastUsedAt: h.at() - MINUTE },
    { id: 'sess_w', owner: 'agent', visibility: 'agent-only', lastUsedAt: h.at() - MINUTE },
  ];
  const service = { listSessionCatalog: async () => ({ sessions: rows, nextCursor: null }) };
  // A new process: no turn seen in memory, only the stored sessions.
  h.restart({ userTurnAt: () => 0, getSessionService: () => service });
  assert.equal(await h.tick(), 'deferred');
  rows.shift();
  assert.equal(await h.tick(), 'nothing', 'task, exec and agent sessions are no user activity');
});

test('the first check after a start is looked at after a minute, then every tick', (t) => {
  const calls = [];
  const timers = {
    setTimeout: (_fn, ms) => (calls.push(['timeout', ms]), { unref() {} }),
    setInterval: (_fn, ms) => (calls.push(['interval', ms]), { unref() {} }),
    clearTimeout: () => calls.push(['clear timeout']),
    clearInterval: () => calls.push(['clear interval']),
  };
  const stop = startMixyHeartbeat({ timers, path: join(tempDir(t), 'heartbeat.json'), isEnabled: async () => false });
  assert.deepEqual(calls, [
    ['timeout', 60_000],
    ['interval', HEARTBEAT_LIMITS.tickMs],
  ]);
  stop();
  assert.deepEqual(calls.slice(2), [['clear timeout'], ['clear interval']]);
});

test('with the setting off nothing runs', async (t) => {
  const h = harness(t, { state: { enabled: false } });
  h.advance(10 * INTERVAL);
  assert.equal(await h.tick(), 'off');
  assert.equal(h.calls.collect.length + h.calls.decide.length + h.calls.wake.length, 0);
  assert.equal(existsSync(h.path), false);
});

test('proposals: one per key, a declined key is never re-offered, at most 5 wait, each expires after 72 hours', (t) => {
  const path = join(tempDir(t), 'heartbeat.json');
  let clock = T0;
  const record = (input) => recordSuggestion(input, { path, now: () => clock });
  const pending = () => readJson(path).pending;
  assert.equal(record({ key: 'Create-Routine:weekly', text: 'Weekly review' }).recorded, true);
  assert.equal(record({ key: 'create-routine:weekly', text: 'Weekly review, Fridays' }).refreshed, true);
  assert.deepEqual(
    pending().map(({ key, text }) => [key, text]),
    [['create-routine:weekly', 'Weekly review, Fridays']]
  );
  for (const name of ['a', 'b', 'c', 'd']) assert.equal(record({ key: `pause-routine:${name}` }).recorded, true);
  assert.equal(record({ key: 'pause-routine:e' }).recorded, false, 'a sixth waits');
  assert.equal(record({ key: 'create-routine:weekly', dismissed: true }).dismissed, true);
  assert.equal(record({ key: 'create-routine:weekly', text: 'again' }).recorded, false, 'declined: never again');
  assert.equal(record({ key: 'pause-routine:e' }).recorded, true);
  clock += HEARTBEAT_LIMITS.suggestionTtlMs;
  assert.equal(record({ key: 'pause-routine:f' }).recorded, true);
  assert.deepEqual(
    pending().map((entry) => entry.key),
    ['pause-routine:f'],
    'the rest expired'
  );
  assert.throws(() => record({ key: 'no target' }), /action:target/);
});

test('declined proposals are kept for good: past hundreds of them the first is still refused and reaches the model', async (t) => {
  const h = harness(t);
  const record = (input) => recordSuggestion(input, { path: h.path, now: h.at });
  for (let index = 0; index < 250; index += 1) record({ key: `create-skill:s${index}`, dismissed: true });
  assert.equal(record({ key: 'create-skill:s0', text: 'Again' }).recorded, false);
  assert.equal(readJson(h.path).pending.length, 0);
  await h.arm();
  assert.equal(await h.tick(), 'nothing');
  const { dismissed } = h.calls.decide[0];
  assert.equal(dismissed.length, 250);
  assert.equal(dismissed[0], 'create-skill:s0');
});

test('sentinels match exactly: NOTHING and HEARTBEAT_QUIET only as the whole reply, WAKE only well formed', () => {
  assert.deepEqual(parseHeartbeatDecision('  NOTHING \n'), { action: 'nothing' });
  const long = `- ${'x'.repeat(301)}`;
  const six = ['WAKE', ...[1, 2, 3, 4, 5, 6].map((n) => `- item ${n}`)].join('\n');
  for (const reply of [
    '',
    'Nothing',
    'NOTHING.',
    'NOTHING\nAll calm.',
    'All calm.\nNOTHING',
    'There is NOTHING to do.',
    'WAKE',
    'WAKE\n- a\nNOTHING',
    'WAKE\n- routine failing\nnote\n- task done',
    `WAKE\n${long}`,
    six,
    'Sure! WAKE\n- a',
  ]) {
    assert.equal(parseHeartbeatDecision(reply), null, reply);
  }
  assert.deepEqual(parseHeartbeatDecision('WAKE\n- routine failing\n\n- task done\n'), {
    action: 'wake',
    items: ['routine failing', 'task done'],
  });
  assert.equal(isQuietReply('HEARTBEAT_QUIET'), true);
  assert.equal(isQuietReply('\n HEARTBEAT_QUIET  '), true);
  for (const reply of ['HEARTBEAT_QUIET.', 'Nothing new. HEARTBEAT_QUIET', 'HEARTBEAT_QUIET\nDone.', 'heartbeat_quiet']) {
    assert.equal(isQuietReply(reply), false, reply);
  }
});

test('the gate is one tool-free, uncached, low-effort Maintainer call that never falls back to the default model', async () => {
  const sends = [];
  let routeArgs = null;
  let route = null;
  const decide = createHeartbeatCompletion({
    loadConfig: () => ({ providers: {} }),
    resolveMaintenanceRoute: (args) => {
      routeArgs = args;
      return route;
    },
    initProviders: async () => {},
    getProvider: () => ({
      send: async (...args) => {
        sends.push(args);
        return { content: 'WAKE\n- schedule failing' };
      },
    }),
    log: () => {},
  });
  assert.deepEqual(await decide({ digest: ['x'] }), { action: 'unmanaged' });
  assert.equal(routeArgs.agent, 'cycle1-agent');
  assert.equal(routeArgs.includeDefault, false);
  assert.equal(sends.length, 0);
  route = { provider: 'fake', model: 'tiny' };
  assert.deepEqual(await decide({ digest: ['schedule "a" failed 3x'], proposals: ['p:q'], dismissed: [] }), {
    action: 'wake',
    items: ['schedule failing'],
  });
  const [[messages, model, tools, options]] = sends;
  assert.equal(model, 'tiny');
  assert.equal(tools, undefined);
  assert.equal(options.effort, 'low');
  assert.equal(options.maxOutputTokens, 300);
  assert.deepEqual(options.cacheStrategy, { tools: 'none', system: 'none', tier3: 'none', messages: 'none' });
  assert.match(messages[1].content, /- schedule "a" failed 3x\n\nOpen proposals: p:q\nDeclined proposals: none/);
});

test("collection counts the user's turns in Mixy's chat but never the heartbeat's own sessions", async () => {
  const since = T0;
  const now = T0 + INTERVAL;
  const rows = [
    { id: HOME, lastUsedAt: now - MINUTE, title: 'Mixy', lastMessagePreview: 'Book the dentist', realTurnCount: 5 },
    { id: 'sess_daemon_hb', sourceName: 'heartbeat', lastUsedAt: now - MINUTE, title: 'Heartbeat' },
    { id: 'sess_lead_a', lastUsedAt: now - MINUTE, title: 'Taxes', lastMessagePreview: 'Filed' },
    { id: 'sess_home_reviewer', lastUsedAt: now - MINUTE, title: 'Reviewer' },
    { id: 'sess_t1', sourceName: 'agent:reviewer@home', lastUsedAt: since + MINUTE, title: 'Fix', preview: 'Done' },
    { id: 'sess_t2', sourceName: 'agent:reviewer', working: true, lastUsedAt: now - 2 * HOUR, title: 'Long' },
    { id: 'sess_old', lastUsedAt: since - HOUR, title: 'Old' },
  ];
  const service = {
    listSessionCatalog: async () => ({ sessions: rows, nextCursor: null }),
    liveSessionAwaitingApproval: (id) => id === 'sess_lead_a',
  };
  const collected = await collectHeartbeatFacts({
    since,
    now,
    getSessionService: () => service,
    routines: async () => [{ kind: 'schedule', name: 'news', enabled: true, consecutiveFailures: 2 }],
    heldRequests: async () => [{ id: 'held_1' }],
    taskWatches: async () => [],
  });
  assert.deepEqual(
    collected.sessions.map((row) => row.id),
    [HOME, 'sess_lead_a', 'sess_home_reviewer']
  );
  assert.deepEqual(
    collected.tasks.map((row) => [row.id, row.state]),
    [
      ['sess_t1', 'finished'],
      ['sess_t2', 'stalled'],
    ]
  );
  assert.equal(collected.approvals, 2);
  assert.deepEqual(collected.routines, [{ kind: 'schedule', name: 'news', enabled: true, failures: 2 }]);
  // The user wrote in Mixy's chat since the last check (4 turns then, 5 now).
  const digest = composeDigest(collected, { routines: {}, mixyTurns: 4 }, now);
  assert.deepEqual(digest.lines, [
    'schedule "news" failed 2x in a row',
    '2 approvals waiting for the user',
    'task session sess_t1 of bot reviewer finished: "Fix", last: "Done"',
    'task session sess_t2 of bot reviewer has shown no activity for over an hour while working: "Long"',
    'new activity in sess_home_lead (bot lead): "Mixy", last: "Book the dentist"',
    'new activity in sess_lead_a: "Taxes", last: "Filed"',
    'new activity in sess_home_reviewer (bot reviewer): "Reviewer"',
  ]);
  assert.equal(digest.mixyTurns, 5);
  // Only a posted heartbeat reply since then: no turn of the user, no activity.
  const quiet = composeDigest(collected, { routines: {}, mixyTurns: 5 }, now);
  assert.equal(
    quiet.lines.some((line) => line.includes(HOME)),
    false
  );
});

test('setup turns the heartbeat off and on and status features reports it', async () => {
  let config = { profile: { title: 'kept' } };
  const api = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
  });
  const run = async (facade, args) =>
    JSON.parse(await createSetupToolExecutor({ getApi: () => facade, getConfig: () => config }).execute(args, {}));
  const off = await run(api, { action: 'set_heartbeat_enabled', enabled: false });
  assert.equal(off.heartbeat, false);
  assert.equal(config.heartbeat, false);
  assert.deepEqual(config.profile, { title: 'kept' });
  assert.deepEqual((await run({}, { action: 'status', domain: 'features' })).heartbeat, { enabled: false });
  await run(api, { action: 'set_heartbeat_enabled', enabled: true });
  assert.deepEqual((await run({}, { action: 'status', domain: 'features' })).heartbeat, { enabled: true });
  await assert.rejects(run(api, { action: 'set_heartbeat_enabled', enabled: 'no' }), /boolean/);
});
