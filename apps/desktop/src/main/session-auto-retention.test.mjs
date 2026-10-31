import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SESSION_RETENTION_INTERVAL_MS,
  SESSION_RETENTION_MIN_IDLE_SECONDS,
  SESSION_RETENTION_PASS_CAP,
  SESSION_RETENTION_START_DELAY_MS,
  createSessionRetentionState,
  planSessionRetention,
  readScheduledResumeSessionIds,
  runSessionRetentionPass,
  sessionRetentionHostFor,
  sessionRetentionTickAllowed,
  startSessionRetentionSchedule,
} from './session-auto-retention.ts';
import { SessionHost } from './session-host.ts';
import { SessionLifecycleLocks } from './session-lifecycle-locks.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12);
const DEFAULT_POLICY = { sessionAutoArchiveDays: 7, sessionAutoDeleteDays: 90 };

const session = (id, extra = {}) => ({
  id,
  title: id,
  preview: id,
  messageCount: 4,
  readMessageCount: 4,
  cwd: '',
  classification: 'task',
  projectPath: null,
  updatedAt: NOW - 8 * DAY,
  activityAt: NOW - 8 * DAY,
  ...extra,
});

function input(sessions, overrides = {}) {
  return {
    now: NOW,
    policy: DEFAULT_POLICY,
    record: { enabledAt: NOW - 365 * DAY, restored: {} },
    sessions,
    storedRows: sessions.map((row) => ({ id: row.id, owner: 'user', agent: 'lead' })),
    archivedAt: {},
    isVisible: () => false,
    hasBackgroundJobs: () => false,
    hasScheduledResume: () => false,
    ...overrides,
  };
}

const archivePlan = (sessions, overrides) => planSessionRetention(input(sessions, overrides)).archive;
const deletePlan = (sessions, overrides) => planSessionRetention(input(sessions, overrides)).delete;

test('with the default 7 days, a session unused for 8 days is archived and one used 6 days ago is not', () => {
  assert.deepEqual(archivePlan([session('sess_old'), session('sess_recent', { activityAt: NOW - 6 * DAY })]), [
    'sess_old',
  ]);
  // Never turns auto-archive off.
  assert.deepEqual(
    archivePlan([session('sess_old')], { policy: { ...DEFAULT_POLICY, sessionAutoArchiveDays: 0 } }),
    []
  );
});

test('every auto-archive exemption keeps an otherwise due session', () => {
  const exempt = {
    running: session('sess_a', { working: true }),
    leadRunning: session('sess_b', { leadWorking: true }),
    agentsWorking: session('sess_c', { agentWorking: true }),
    favorite: session('sess_d', { favorite: true }),
    botHome: session('sess_e', { agentHome: 'mixy' }),
    room: session('sess_f', { agentRoom: { id: 'room' } }),
    agentMode: session('sess_g', { sessionMode: 'agent' }),
    schedule: session('sess_h', { sourceType: 'schedule' }),
    webhook: session('sess_i', { sourceType: 'webhook' }),
    automationTask: session('sess_j', { taskFrom: 'run' }),
    unread: session('sess_k', { messageCount: 6, readMessageCount: 4 }),
  };
  for (const [rule, row] of Object.entries(exempt)) assert.deepEqual(archivePlan([row]), [], rule);
  const row = session('sess_x');
  assert.deepEqual(archivePlan([row], { isVisible: (id) => id === 'sess_x' }), [], 'open on screen');
  assert.deepEqual(archivePlan([row], { hasBackgroundJobs: (id) => id === 'sess_x' }), [], 'background jobs');
  assert.deepEqual(archivePlan([row], { hasScheduledResume: (id) => id === 'sess_x' }), [], 'scheduled resume');
  // The control: the same row with none of them is archived.
  assert.deepEqual(archivePlan([row]), ['sess_x']);
});

test('a session waiting on the user is kept for a day; one waiting longer can be archived', () => {
  const policy = { ...DEFAULT_POLICY, sessionAutoArchiveDays: 1 };
  const waiting = (activityAgo) => session('sess_w', { awaitingApproval: true, activityAt: NOW - activityAgo });
  assert.deepEqual(archivePlan([waiting(DAY - 60_000)], { policy }), []);
  assert.deepEqual(archivePlan([waiting(2 * DAY)], { policy }), ['sess_w']);
});

test('unread output is judged by the shared read cursor; a never-read session reads as seen', () => {
  assert.deepEqual(archivePlan([session('sess_u', { messageCount: 6, readMessageCount: 4 })]), []);
  assert.deepEqual(archivePlan([session('sess_u', { messageCount: 6, readMessageCount: undefined })]), ['sess_u']);
  // A bot-style row whose growth past the cursor is only the user's own words.
  assert.deepEqual(archivePlan([session('sess_u', { messageCount: 6, readMessageCount: 4, incomingTail: [3, 4] })]), [
    'sess_u',
  ]);
});

test('live sub-sessions keep their parent; an archived or idle sub-session does not; sub-agents are never candidates', () => {
  const parent = session('sess_p');
  const child = (extra) => ({
    id: 'sess_child',
    owner: 'agent',
    agent: 'worker',
    visibility: 'agent-only',
    ownerSessionId: 'sess_p',
    updatedAt: NOW - 30 * DAY,
    lastUsedAt: NOW - 30 * DAY,
    ...extra,
  });
  const rows = (extra) => [{ id: 'sess_p', owner: 'user', agent: 'lead' }, child(extra)];
  const childSummary = session('sess_child', { activityAt: NOW - 30 * DAY });
  assert.deepEqual(archivePlan([parent, childSummary], { storedRows: rows({ working: true }) }), []);
  assert.deepEqual(archivePlan([parent], { storedRows: rows({ lastUsedAt: NOW - DAY }) }), []);
  assert.deepEqual(archivePlan([parent], { storedRows: rows({ awaitingApproval: true }) }), []);
  // Idle child, or a recently active child that is already archived: the
  // parent goes, the child itself never (sub-agent retention owns it).
  assert.deepEqual(archivePlan([parent, childSummary], { storedRows: rows({}) }), ['sess_p']);
  assert.deepEqual(
    archivePlan([parent], { storedRows: rows({ lastUsedAt: NOW - DAY }), archivedAt: { sess_child: NOW - DAY } }),
    ['sess_p']
  );
});

test('a restored session stays out of auto-archive until it is used again, then ages from that use', () => {
  const restoredAt = NOW - 30 * DAY;
  const record = { enabledAt: NOW - 365 * DAY, restored: { sess_r: restoredAt } };
  // Last used before the restore: kept however long ago.
  assert.deepEqual(archivePlan([session('sess_r', { activityAt: NOW - 60 * DAY })], { record }), []);
  // Used after the restore and idle 8 days since: archived again.
  assert.deepEqual(archivePlan([session('sess_r', { activityAt: NOW - 8 * DAY })], { record }), ['sess_r']);
  // Used after the restore, recently: kept by the normal clock.
  assert.deepEqual(archivePlan([session('sess_r', { activityAt: NOW - 2 * DAY })], { record }), []);
});

test('auto-delete takes only archived, non-favorite sessions past 90 days by default, oldest first', () => {
  const archivedAt = {
    sess_a: NOW - 91 * DAY,
    sess_b: NOW - 120 * DAY,
    sess_c: NOW - 30 * DAY,
    sess_fav: NOW - 200 * DAY,
  };
  const rows = [
    session('sess_a', { archived: true }),
    session('sess_b', { archived: true }),
    session('sess_c', { archived: true }),
    session('sess_fav', { archived: true, favorite: true }),
    session('sess_open'),
  ];
  assert.deepEqual(deletePlan(rows, { archivedAt }), ['sess_b', 'sess_a']);
  assert.deepEqual(deletePlan(rows, { archivedAt, policy: { ...DEFAULT_POLICY, sessionAutoDeleteDays: 0 } }), []);
  // Not archived: never deleted, however old.
  assert.ok(!deletePlan(rows, { archivedAt }).includes('sess_open'));
  // A bot's chat (even a deleted bot's archived one) is permanent.
  assert.deepEqual(
    deletePlan([session('sess_home', { archived: true, agentHome: 'mixy' })], {
      archivedAt: { sess_home: NOW - 400 * DAY },
    }),
    []
  );
});

test('grace: an archive older than the feature counts its 90 days from when the feature was enabled', () => {
  const rows = [session('sess_old', { archived: true })];
  const archivedAt = { sess_old: NOW - 400 * DAY };
  const enabled = (ago) => ({ enabledAt: NOW - ago, restored: {} });
  assert.deepEqual(deletePlan(rows, { archivedAt, record: enabled(0) }), []);
  assert.deepEqual(deletePlan(rows, { archivedAt, record: enabled(89 * DAY) }), []);
  assert.deepEqual(deletePlan(rows, { archivedAt, record: enabled(90 * DAY) }), ['sess_old']);
  // An archive after the feature started counts from its own date.
  assert.deepEqual(deletePlan(rows, { archivedAt: { sess_old: NOW - 10 * DAY }, record: enabled(200 * DAY) }), []);
});

function passHost(sessions, overrides = {}) {
  const calls = { archived: [], deleted: [], worktreeAsked: [], logs: [] };
  const locks = new SessionLifecycleLocks();
  const view = async () => {
    const { now: _now, policy: _policy, record: _record, ...rest } = input(sessions, overrides.view);
    return rest;
  };
  const host = {
    readPolicy: async () => DEFAULT_POLICY,
    state: { load: async () => ({ enabledAt: NOW - 365 * DAY, restored: {} }) },
    view,
    freshView: view,
    withSessionLock: (id, task) => locks.run(id, task),
    contended: (id) => locks.contended(id),
    lifecycleVersion: (id) => locks.version(id),
    residentToken: () => 'resident',
    archive: async (id) => {
      calls.archived.push(id);
    },
    deleteIfIdle: async (id) => {
      calls.deleted.push(id);
      return { deleted: true };
    },
    worktreeWork: async (ids) => {
      calls.worktreeAsked.push(ids);
      return [];
    },
    log: (line) => calls.logs.push(line),
    ...overrides.host,
  };
  return { host, calls };
}

test('a pass acts on at most 50 sessions, archives first, and logs what it did', async () => {
  const due = Array.from({ length: 45 }, (_, index) =>
    session(`sess_a${index}`, { activityAt: NOW - (10 + index) * DAY })
  );
  const archived = Array.from({ length: 10 }, (_, index) => session(`sess_d${index}`, { archived: true }));
  const archivedAt = Object.fromEntries(archived.map((row, index) => [row.id, NOW - (100 + index) * DAY]));
  const { host, calls } = passHost([...due, ...archived], { view: { archivedAt } });
  const report = await runSessionRetentionPass(host, () => NOW);
  assert.equal(SESSION_RETENTION_PASS_CAP, 50);
  assert.equal(calls.archived.length, 45);
  assert.equal(calls.deleted.length, 5);
  // Oldest first in both lists.
  assert.equal(calls.archived[0], 'sess_a44');
  assert.deepEqual(calls.deleted, ['sess_d9', 'sess_d8', 'sess_d7', 'sess_d6', 'sess_d5']);
  assert.deepEqual(report.archived, calls.archived);
  assert.equal(calls.logs.length, 1);
  assert.match(calls.logs[0], /auto-retention: archived 45 \(sess_a44, .*\+35 more\), deleted 5 \(sess_d9/);
});

test('a session whose worktree holds work is kept archived; an unknown worktree state deletes nothing', async () => {
  const rows = [session('sess_dirty', { archived: true }), session('sess_clean', { archived: true })];
  const archivedAt = { sess_dirty: NOW - 100 * DAY, sess_clean: NOW - 95 * DAY };
  const holding = passHost(rows, { view: { archivedAt }, host: { worktreeWork: async () => ['sess_dirty'] } });
  const report = await runSessionRetentionPass(holding.host, () => NOW);
  assert.deepEqual(holding.calls.deleted, ['sess_clean']);
  assert.deepEqual(report.keptForWorktree, ['sess_dirty']);
  const failing = passHost(rows, {
    view: { archivedAt },
    host: {
      worktreeWork: async () => {
        throw new Error('WORKTREE_NOT_IMPLEMENTED');
      },
    },
  });
  await runSessionRetentionPass(failing.host, () => NOW);
  assert.deepEqual(failing.calls.deleted, []);
  assert.ok(failing.calls.logs.some((line) => /delete sess_dirty: WORKTREE_NOT_IMPLEMENTED/.test(line)));
});

test('protected sessions do not starve newer ones: the sweep moves past them in bounded passes', async () => {
  const rows = Array.from({ length: 121 }, (_, index) => session(`sess_d${index}`, { archived: true }));
  // sess_d0 is the oldest; the first 120 keep worktree work, the last is deletable.
  const archivedAt = Object.fromEntries(rows.map((row, index) => [row.id, NOW - (300 - index) * DAY]));
  const protectedIds = new Set(rows.slice(0, 120).map((row) => row.id));
  let checks = 0;
  const { host, calls } = passHost(rows, {
    view: { archivedAt },
    host: {
      worktreeWork: async (ids) => {
        checks += ids.length;
        return ids.filter((id) => protectedIds.has(id));
      },
    },
  });
  const pending = new Set();
  const perPass = [];
  for (let pass = 0; pass < 3; pass += 1) {
    checks = 0;
    await runSessionRetentionPass(host, () => NOW, { pending });
    perPass.push(checks);
  }
  assert.deepEqual(perPass, [50, 50, 21]);
  assert.deepEqual(calls.deleted, ['sess_d120'], 'protected sessions are kept, never deleted');
});

test('a session examined earlier in a sweep is revisited even while a newcomer arrives before every pass', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => session(`sess_p${index}`, { archived: true }));
  const archivedAt = Object.fromEntries(rows.map((row, index) => [row.id, NOW - (300 - index) * DAY]));
  const protectedIds = new Set(rows.map((row) => row.id));
  const { host, calls } = passHost(rows, {
    view: { archivedAt },
    host: { worktreeWork: async (ids) => ids.filter((id) => protectedIds.has(id)) },
  });
  const pending = new Set();
  await runSessionRetentionPass(host, () => NOW, { pending });
  // sess_p0 was examined as protected; now its worktree is clean.
  protectedIds.delete('sess_p0');
  for (let pass = 0; pass < 4 && !calls.deleted.includes('sess_p0'); pass += 1) {
    const newcomer = session(`sess_n${pass}`, { archived: true });
    rows.push(newcomer);
    archivedAt[newcomer.id] = NOW - 95 * DAY;
    protectedIds.add(newcomer.id);
    await runSessionRetentionPass(host, () => NOW, { pending });
  }
  assert.ok(calls.deleted.includes('sess_p0'), 'revisited within the next sweep');
});

test('a user who becomes active ends the pass before the next session', async () => {
  let asked = 0;
  const { host, calls } = passHost([session('sess_a'), session('sess_b')]);
  await runSessionRetentionPass(host, () => NOW, { stillIdle: async () => ++asked < 2 });
  assert.deepEqual(calls.archived, ['sess_a']);
});

test('stopping during a slow worktree check finishes within a bound and deletes nothing', async () => {
  const controller = new AbortController();
  const slow = Promise.withResolvers();
  const { host, calls } = passHost([session('sess_d', { archived: true })], {
    view: { archivedAt: { sess_d: NOW - 100 * DAY } },
    host: { worktreeWork: () => slow.promise },
  });
  const pass = runSessionRetentionPass(host, () => NOW, { signal: controller.signal });
  await settled();
  controller.abort();
  const outcome = await Promise.race([pass, new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]);
  assert.notEqual(outcome, 'timeout', 'the pass ended without waiting for the check');
  slow.resolve([]);
  await settled();
  assert.deepEqual(calls.deleted, []);
});

test('stopping while queued for the session lock abandons the wait and mutates nothing later', async () => {
  const controller = new AbortController();
  const { host, calls } = passHost([session('sess_a')]);
  const holder = Promise.withResolvers();
  const holding = host.withSessionLock('sess_a', () => holder.promise);
  const pass = runSessionRetentionPass(host, () => NOW, { signal: controller.signal });
  await settled();
  controller.abort();
  const outcome = await Promise.race([pass, new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]);
  assert.notEqual(outcome, 'timeout');
  holder.resolve();
  await holding;
  await settled();
  assert.deepEqual(calls.archived, []);
});

test('a fresh view that cannot be read, or a turn seen in it, skips the session', async () => {
  const unsure = passHost([session('sess_a')], { host: { freshView: async () => null } });
  assert.deepEqual((await runSessionRetentionPass(unsure.host, () => NOW)).skipped, ['sess_a']);
  assert.deepEqual(unsure.calls.archived, []);
  const started = passHost([session('sess_a')]);
  started.host.freshView = async () => {
    const { now: _now, policy: _policy, record: _record, ...rest } = input([session('sess_a', { working: true })]);
    return rest;
  };
  await runSessionRetentionPass(started.host, () => NOW);
  assert.deepEqual(started.calls.archived, []);
});

test('a resident change after the slow reads, or a daemon refusal, stops the delete', async () => {
  const archivedAt = { sess_d: NOW - 100 * DAY };
  const rows = [session('sess_d', { archived: true })];
  // The cached row moved (a catalog refresh saw a turn) while the worktree was checked.
  let moved = false;
  const changed = passHost(rows, {
    view: { archivedAt },
    host: {
      residentToken: () => (moved ? 'after' : 'before'),
      worktreeWork: async () => {
        moved = true;
        return [];
      },
    },
  });
  assert.deepEqual((await runSessionRetentionPass(changed.host, () => NOW)).skipped, ['sess_d']);
  assert.deepEqual(changed.calls.deleted, []);
  // The daemon's own check found a turn: nothing deleted, reported as skipped.
  const refused = passHost(rows, {
    view: { archivedAt },
    host: { deleteIfIdle: async () => ({ deleted: false, reason: 'busy' }) },
  });
  assert.deepEqual((await runSessionRetentionPass(refused.host, () => NOW)).skipped, ['sess_d']);
});

test('an invalid or fully-off policy makes the pass do nothing', async () => {
  for (const policy of [null, { sessionAutoArchiveDays: 0, sessionAutoDeleteDays: 0 }]) {
    let viewed = false;
    const { host, calls } = passHost([session('sess_old')], {
      host: {
        readPolicy: async () => policy,
        view: async () => {
          viewed = true;
          return {};
        },
      },
    });
    assert.equal(await runSessionRetentionPass(host, () => NOW), null);
    assert.equal(viewed, false);
    assert.deepEqual(calls.archived, []);
  }
});

test('a session opened on screen after the plan is left alone', async () => {
  let opened = false;
  const { host, calls } = passHost([session('sess_a'), session('sess_b')], {
    view: { isVisible: (id) => opened && id === 'sess_b' },
    host: {
      archive: async (id) => {
        calls.archived.push(id);
        opened = true;
      },
    },
  });
  await runSessionRetentionPass(host, () => NOW);
  assert.deepEqual(calls.archived, ['sess_a']);
});

test('scheduling: no pass in the first 10 minutes, while the user is active, idle unknown, or one in flight', () => {
  const at = (elapsed, idleSeconds, running = false) =>
    sessionRetentionTickAllowed({ now: 1_000_000 + elapsed, startedAt: 1_000_000, running, idleSeconds });
  assert.equal(SESSION_RETENTION_START_DELAY_MS, 10 * 60 * 1000);
  assert.equal(SESSION_RETENTION_MIN_IDLE_SECONDS, 15 * 60);
  assert.equal(at(SESSION_RETENTION_START_DELAY_MS - 1, 3600), false);
  assert.equal(at(SESSION_RETENTION_START_DELAY_MS, 14 * 60), false);
  assert.equal(at(SESSION_RETENTION_START_DELAY_MS, null), false);
  assert.equal(at(SESSION_RETENTION_START_DELAY_MS, 15 * 60, true), false);
  assert.equal(at(SESSION_RETENTION_START_DELAY_MS, 15 * 60), true);
});

test('the schedule ticks every 15 minutes, runs only when allowed, and never overlaps a pass', async () => {
  let now = 0;
  let idle = 3600;
  let intervalMs = 0;
  let cleared = false;
  const release = Promise.withResolvers();
  let runs = 0;
  const schedule = startSessionRetentionSchedule({
    clock: () => now,
    idleSeconds: async () => idle,
    run: async () => {
      runs += 1;
      await release.promise;
    },
    setInterval: (_fn, ms) => {
      intervalMs = ms;
      return { unref() {} };
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  assert.equal(intervalMs, SESSION_RETENTION_INTERVAL_MS);
  assert.equal(await schedule.tick(), false, 'inside the start delay');
  now = SESSION_RETENTION_START_DELAY_MS;
  idle = 60;
  assert.equal(await schedule.tick(), false, 'user active');
  idle = 3600;
  const first = schedule.tick();
  assert.equal(await schedule.tick(), false, 'a pass is in flight');
  release.resolve();
  assert.equal(await first, true);
  assert.equal(runs, 1);
  await schedule.stop();
  assert.equal(cleared, true);
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('stopping while the idle read is pending starts no pass, and stop resolves once the tick has settled', async () => {
  let now = 0;
  const idle = Promise.withResolvers();
  let runs = 0;
  const schedule = startSessionRetentionSchedule({
    clock: () => now,
    idleSeconds: () => idle.promise,
    run: async () => {
      runs += 1;
    },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  now = SESSION_RETENTION_START_DELAY_MS;
  const tick = schedule.tick();
  let stopped = false;
  const stopping = schedule.stop().then(() => {
    stopped = true;
  });
  await settled();
  assert.equal(stopped, false, 'stop waits for the tick in flight');
  idle.resolve(3600);
  await stopping;
  assert.equal(await tick, false);
  assert.equal(runs, 0, 'the idle answer arrived after stop');
  assert.equal(await schedule.tick(), false, 'no tick after stop');
  assert.equal(runs, 0);
});

test('stopping during a pass aborts it and resolves only after it has settled', async () => {
  let now = 0;
  const release = Promise.withResolvers();
  let passSignal = null;
  const schedule = startSessionRetentionSchedule({
    clock: () => now,
    idleSeconds: async () => 3600,
    run: async ({ signal }) => {
      passSignal = signal;
      await release.promise;
    },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  now = SESSION_RETENTION_START_DELAY_MS;
  const tick = schedule.tick();
  await settled();
  assert.equal(passSignal?.aborted, false);
  let stopped = false;
  const stopping = schedule.stop().then(() => {
    stopped = true;
  });
  await settled();
  assert.equal(passSignal.aborted, true);
  assert.equal(stopped, false, 'the pass is still running');
  release.resolve();
  await stopping;
  assert.equal(await tick, true);
});

test('an aborted pass starts no further session and lets the one in progress finish', async () => {
  const controller = new AbortController();
  const { host, calls } = passHost(
    [
      session('sess_a', { activityAt: NOW - 30 * DAY }),
      session('sess_b', { activityAt: NOW - 20 * DAY }),
      session('sess_c', { activityAt: NOW - 10 * DAY }),
    ],
    {
      host: {
        archive: async (id) => {
          calls.archived.push(id);
          controller.abort();
        },
      },
    }
  );
  const report = await runSessionRetentionPass(host, () => NOW, { signal: controller.signal });
  assert.deepEqual(calls.archived, ['sess_a']);
  assert.deepEqual(report.archived, ['sess_a']);
  const before = passHost([session('sess_a')]);
  controller.abort();
  assert.equal(await runSessionRetentionPass(before.host, () => NOW, { signal: controller.signal }), null);
  assert.deepEqual(before.calls.archived, []);
});

test('the retention record dates the feature once and tracks restores in a temp data dir', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session-auto-retention.json');
  let clock = 1000;
  const state = createSessionRetentionState(file, () => clock);
  assert.deepEqual(await state.load(), { enabledAt: 1000, restored: {} });
  clock = 5000;
  assert.equal((await state.load()).enabledAt, 1000, 'the enable date never moves');
  await state.noteArchived('sess_a', false);
  assert.deepEqual((await state.load()).restored, { sess_a: 5000 });
  await state.noteArchived('sess_a', true);
  await state.noteArchived('sess_b', false);
  await state.forget('sess_b');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { enabledAt: 1000, restored: {} });
});

test('the quota-resume queue is read fresh: its sessions are scheduled targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual([...(await readScheduledResumeSessionIds(root))], []);
  await writeFile(
    join(root, 'quota-resume.json'),
    JSON.stringify({ version: 1, entries: [{ sessionId: 'sess_q', turnKey: 't' }, {}] })
  );
  assert.deepEqual([...(await readScheduledResumeSessionIds(root))], ['sess_q']);
});

const lead = (id, extra = {}) => {
  const old = Date.now() - 30 * DAY;
  return {
    id,
    owner: 'user',
    agent: 'lead',
    sourceType: 'lead',
    messageCount: 2,
    preview: id,
    updatedAt: old,
    lastUsedAt: old,
    ...extra,
  };
};

/** A real SessionHost over a fake daemon in a temp data dir: `rows` is the
 *  daemon's catalog; a submit starts a turn (the row reads working); the
 *  control methods are `control` (deleteSession removes the row). */
async function realHost(t, rows, control = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-retention-host-'));
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => ({
        list: async () => ({ sessions: rows.map((row) => ({ ...row })) }),
        submit: async ({ sessionId }) => {
          const row = rows.find((entry) => entry.id === sessionId);
          if (row) row.working = true;
          return { sessionId, accepted: true };
        },
        close: async () => {},
      }),
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  // No engine frame in a test: the fresh job scan answers "none running".
  host.shellJobsPoller.freshStatusFor = async () => ({ count: 0, jobs: [] });
  const forwarded = [];
  host.transport.invokeControl = async (method, args) => {
    forwarded.push([method, args]);
    if (control[method]) return control[method](...args);
    if (method === 'deleteSessionIfIdle') {
      const index = rows.findIndex((row) => row.id === args[0]);
      if (index < 0 || rows[index].lastUsedAt !== args[1].lastUsedAt) return { deleted: false, reason: 'changed' };
      rows.splice(index, 1);
      return { deleted: true };
    }
    if (method === 'getSessionWorktreeWork') return { sessionIds: [] };
    return null;
  };
  const deletedUploads = [];
  const retentionHost = (overrides = {}) => ({
    ...sessionRetentionHostFor(host, {
      readPolicy: async () => DEFAULT_POLICY,
      onDeleted: (id) => deletedUploads.push(id),
      dataDirectory: () => root,
      log: () => {},
    }),
    ...overrides,
  });
  return { host, forwarded, retentionHost, deletedUploads };
}

test('through the real host: a restore exempts the session, and auto-archive uses the manual archive path', async (t) => {
  const rows = [
    lead('sess_lead'),
    { ...lead('sess_w1'), owner: 'agent', agent: 'worker', visibility: 'agent-only', ownerSessionId: 'sess_lead' },
    lead('sess_busy', { working: true }),
  ];
  const { host, forwarded, retentionHost } = await realHost(t, rows);
  // The user restores it: the pass leaves it alone although it is 30 days idle.
  await host.setSessionArchived('sess_lead', true);
  await host.setSessionArchived('sess_lead', false);
  forwarded.length = 0;
  assert.deepEqual((await runSessionRetentionPass(retentionHost())).archived, []);
  assert.deepEqual((await host.sessionSidebarState()).archived, {});
  // Without the restore record it is archived with its sub-agent, and the
  // worktrees follow exactly as a manual archive's do; the running one stays.
  await host.sessionRetention.noteArchived('sess_lead', true);
  assert.deepEqual((await runSessionRetentionPass(retentionHost())).archived, ['sess_lead']);
  assert.deepEqual(Object.keys((await host.sessionSidebarState()).archived).sort(), ['sess_lead', 'sess_w1']);
  assert.deepEqual(forwarded, [
    ['setArchivedSessionWorktrees', [{ sessionIds: ['sess_lead', 'sess_w1'], archived: true }]],
  ]);
});

test('race: a restore during the awaited worktree check lands at once and the session is never deleted', async (t) => {
  // The pass runs 200 days ahead, so the archive made now is past its 90 days.
  const later = () => Date.now() + 200 * DAY;
  const rows = [lead('sess_old'), lead('sess_control')];
  const checked = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const { host, forwarded, retentionHost, deletedUploads } = await realHost(t, rows, {
    getSessionWorktreeWork: async ({ sessionIds }) => {
      if (sessionIds[0] !== 'sess_old') return { sessionIds: [] };
      checked.resolve();
      await answer.promise;
      return { sessionIds: [] };
    },
  });
  await host.setSessionArchived('sess_old', true);
  await host.setSessionArchived('sess_control', true);
  const pass = runSessionRetentionPass(retentionHost(), later);
  await checked.promise;
  // The user restores it while the pass waits on the worktree inspection:
  // the restore does not wait for the inspection.
  await host.setSessionArchived('sess_old', false);
  answer.resolve();
  const report = await pass;
  assert.deepEqual(report.deleted, ['sess_control'], 'the same pass deletes an untouched one');
  assert.deepEqual(deletedUploads, ['sess_control']);
  assert.deepEqual(report.skipped, ['sess_old']);
  assert.ok(rows.some((row) => row.id === 'sess_old'));
  assert.ok(!forwarded.some(([method, args]) => method === 'deleteSessionIfIdle' && args[0] === 'sess_old'));
  assert.deepEqual((await host.sessionSidebarState()).archived, {});
});

test('a daemon refusal at the conditional delete leaves the session and its records', async (t) => {
  const later = () => Date.now() + 200 * DAY;
  const rows = [lead('sess_old')];
  const { host, retentionHost, deletedUploads } = await realHost(t, rows, {
    // A bot turn the daemon started after the pass's reads: the daemon refuses.
    deleteSessionIfIdle: async () => ({ deleted: false, reason: 'busy' }),
  });
  await host.setSessionArchived('sess_old', true);
  const report = await runSessionRetentionPass(retentionHost(), later);
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.skipped, ['sess_old']);
  assert.deepEqual(deletedUploads, []);
  assert.ok(rows.some((row) => row.id === 'sess_old'));
  assert.deepEqual(Object.keys((await host.sessionSidebarState()).archived), ['sess_old']);
});

test('race: a favorite between the candidate snapshot and the archive keeps it out', async (t) => {
  const rows = [lead('sess_a'), lead('sess_b'), lead('sess_c')];
  const { host, retentionHost } = await realHost(t, rows);
  const base = retentionHost();
  const report = await runSessionRetentionPass(
    retentionHost({
      // Favorited after the snapshot the plan picks from.
      view: async () => {
        const view = await base.view();
        await host.setSessionFavorite('sess_a', true);
        return view;
      },
      // Favorited after the fresh read, before the pass takes the lock.
      freshView: async (id) => {
        const view = await base.freshView(id);
        if (id === 'sess_b') await host.setSessionFavorite('sess_b', true);
        return view;
      },
    })
  );
  assert.deepEqual(report.archived, ['sess_c']);
  assert.deepEqual(report.skipped.sort(), ['sess_a', 'sess_b']);
  const state = await host.sessionSidebarState();
  assert.deepEqual(Object.keys(state.archived), ['sess_c']);
  assert.deepEqual(Object.keys(state.favorites).sort(), ['sess_a', 'sess_b']);
});

test('race: a turn started before the archive keeps the session out', async (t) => {
  const rows = [lead('sess_a'), lead('sess_b'), lead('sess_c')];
  const { host, retentionHost } = await realHost(t, rows);
  const base = retentionHost();
  const scanHeld = Promise.withResolvers();
  let startedDuringScan = false;
  const report = await runSessionRetentionPass(
    retentionHost({
      // A turn starts after the snapshot, before the pass takes its lock.
      view: async () => {
        const view = await base.view();
        assert.equal(await host.submitToSession('sess_a', 'continue'), true);
        return view;
      },
      // A held slow scan: the turn start completes while it is still held
      // (it never waits on the pass), and the pass then leaves the session.
      freshView: async (id) => {
        if (id !== 'sess_b') return base.freshView(id);
        const view = base.freshView(id);
        void host.submitToSession('sess_b', 'continue').then((accepted) => {
          startedDuringScan = accepted;
          scanHeld.resolve();
        });
        await scanHeld.promise;
        return view;
      },
    })
  );
  assert.equal(startedDuringScan, true);
  assert.deepEqual(report.archived, ['sess_c']);
  assert.deepEqual(report.skipped.sort(), ['sess_a', 'sess_b']);
  assert.deepEqual(Object.keys((await host.sessionSidebarState()).archived), ['sess_c']);
});

test('the lifecycle lock serializes per session, lets its holder re-enter, and reports who waits', async () => {
  const locks = new SessionLifecycleLocks();
  const order = [];
  const gate = Promise.withResolvers();
  const first = locks.run('s', async () => {
    order.push('first');
    // Re-entry from the holder's own chain does not wait on itself.
    await locks.run('s', async () => order.push('nested'));
    await gate.promise;
    return locks.contended('s');
  });
  await Promise.resolve();
  const second = locks.run('s', async () => order.push('second'));
  const other = locks.run('t', async () => order.push('other'));
  await other;
  gate.resolve();
  assert.equal(await first, true);
  await second;
  assert.deepEqual(order, ['first', 'nested', 'other', 'second']);
  assert.equal(locks.contended('s'), false);
});
