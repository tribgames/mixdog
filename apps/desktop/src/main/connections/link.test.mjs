import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../shared/contract-notifications.ts';
import {
  ConnectionLink,
  LINK_FAILURE_LIMIT,
  LINK_HEALTH_INTERVAL_MS,
  LINK_PROBE_TIMEOUT_MS,
  LINK_STABLE_RESET_MS,
  REMOTE_CLIENT_GRACE_DEFAULT_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectLadder,
  reconnectDelayCapMs,
  remoteClientGraceMs,
} from './connection-link.ts';
import { describeLinkFailure, isSignInFailure } from './desktop-connection.ts';
import { forwardConnectionLink } from './link-ipc.ts';
import { createConnectionManager } from './manager.ts';
import { ConnectionPool } from './pool.ts';
import { REATTACH_SESSIONS_WAIT_MS, createReattachReport } from './reattach-report.ts';
import {
  LINK_LOST_NOTICE_DELAY_MS,
  NOTIFICATION_BODY_CHARS,
  NOTIFICATION_TITLE_CHARS,
  boundedNotification,
  createServerNotifier,
} from './server-notifier.ts';
import { daemonIdentityError, isExpectedDaemon, readDaemonHealth } from '../ssh/remote-session.ts';
import { createServer } from 'node:http';
import { SERVER_WINDOWS_FILE, createServerWindowRestore } from './window-restore.ts';
import { SshError } from '../ssh/ssh-command.ts';
import { RemoteBootstrapError } from '../ssh/remote-bootstrap.ts';
import { DesktopServiceClient } from '../desktop-service-client.ts';

/** Manual clock: timers fire only when the test advances time. */
function fakeTimers(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    setInterval: (callback, ms) => {
      const id = nextId++;
      const entry = { at: now + ms, callback, every: ms };
      pending.set(id, entry);
      return id;
    },
    clearInterval: (id) => pending.delete(id),
  };
  const advance = async (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, entry] = due;
      now = entry.at;
      if (entry.every) entry.at += entry.every;
      else pending.delete(id);
      entry.callback();
      await settle();
    }
    now = until;
    await settle();
  };
  return {
    timers,
    advance,
    pending,
    get now() {
      return now;
    },
  };
}

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

function linkFixture({ graceMs = REMOTE_CLIENT_GRACE_DEFAULT_MS, probe, stoppedBy = () => null, autoReconnect } = {}) {
  const clock = fakeTimers();
  const calls = [];
  const probes = [];
  const actions = {
    probe: async (timeoutMs) => {
      probes.push(timeoutMs);
      return probe ? probe(probes.length) : 12;
    },
    resetTunnel: () => calls.push('resetTunnel'),
    reviveTunnel: () => calls.push('reviveTunnel'),
    retryService: () => calls.push('retryService'),
    stoppedBy,
    hold: () => calls.push('hold'),
    release: () => calls.push('release'),
  };
  const link = new ConnectionLink({ connectionId: 'srv-1', graceMs, autoReconnect, actions, timers: clock.timers });
  const views = [];
  link.subscribe((view) => views.push(view));
  return { link, clock, calls, probes, views, actions };
}

test('the link state machine: connected → reconnecting with attempt and countdown → connected', async () => {
  const f = linkFixture({ probe: () => null });
  f.link.start();
  assert.deepEqual(f.link.view().state, { status: 'connected' });
  f.link.serviceLost();
  let state = f.link.view().state;
  assert.equal(state.status, 'reconnecting');
  assert.equal(state.attempt, 1);
  assert.equal(state.nextRetryAt, f.clock.now + 1_000, 'the first retry is one second out');
  // The attempt runs on time: the probe fails, a dead tunnel child is revived,
  // and the next attempt is scheduled further out.
  await f.clock.advance(1_000);
  assert.deepEqual(f.calls, ['reviveTunnel']);
  state = f.link.view().state;
  assert.equal(state.attempt, 2);
  assert.equal(state.nextRetryAt, f.clock.now + 2_000);
  // The service re-attaches on its own: connected, nothing pending.
  f.link.serviceRestored();
  assert.deepEqual(f.link.view().state, { status: 'connected' });
  assert.equal(f.clock.pending.size, 1, 'only the health interval stays');
  // A terminal failure is lost for good; nothing is attempted.
  f.link.terminal({ code: 'auth', message: 'Permission denied', settingsRequired: true });
  assert.deepEqual(f.link.view().state, {
    status: 'lost',
    terminal: true,
    code: 'auth',
    message: 'Permission denied',
    settingsRequired: true,
  });
  await f.clock.advance(120_000);
  assert.equal(f.link.view().state.status, 'lost');
  // Reopened (the user's Reconnect): reconnecting again, then attached.
  f.link.reopening();
  assert.deepEqual(f.link.view().state, { status: 'reconnecting', attempt: 1, nextRetryAt: null });
  f.link.serviceRestored();
  assert.equal(f.link.view().state.status, 'connected');
});

test('Reconnect now runs the waiting attempt at once and keeps the backoff ladder', async () => {
  const f = linkFixture({ probe: () => null });
  f.link.start();
  f.link.serviceLost();
  await f.clock.advance(1_000);
  let state = f.link.view().state;
  assert.equal(state.attempt, 2);
  const skippedAt = state.nextRetryAt;
  await f.clock.advance(500);
  const probesBefore = f.probes.length;
  f.link.attemptNow();
  await settle();
  assert.equal(f.probes.length, probesBefore + 1, 'the attempt ran now');
  assert.deepEqual(f.calls, ['reviveTunnel', 'reviveTunnel']);
  state = f.link.view().state;
  // The ladder moved one step (attempt 3, 4 s) instead of starting over.
  assert.equal(state.attempt, 3);
  assert.equal(state.nextRetryAt, f.clock.now + 4_000);
  assert.equal(f.clock.pending.size, 2, 'the health interval and the one new countdown');
  // The skipped countdown never fires on its own.
  await f.clock.advance(skippedAt - f.clock.now);
  assert.equal(f.probes.length, probesBefore + 1);

  // Nothing to skip: an attempt in flight, connected, or lost.
  f.link.serviceRestored();
  f.link.attemptNow();
  await settle();
  assert.deepEqual(f.link.view().state, { status: 'connected' });
  f.link.terminal({ code: 'auth', message: 'Permission denied' });
  f.link.attemptNow();
  await settle();
  assert.equal(f.link.view().state.status, 'lost');
  assert.equal(f.probes.length, probesBefore + 1);
});

test('Reconnect now keeps the outage start: past the server grace the link is lost', async () => {
  const graceMs = 20_000;
  const f = linkFixture({ graceMs, probe: () => null });
  f.link.start();
  const lostAt = f.clock.now;
  f.link.serviceLost();
  // Let attempts fail on time until the grace has passed with one countdown
  // still waiting (scheduled before the grace ran out).
  for (;;) {
    const { nextRetryAt } = f.link.view().state;
    if (nextRetryAt > lostAt + graceMs) {
      await f.clock.advance(lostAt + graceMs - f.clock.now);
      break;
    }
    await f.clock.advance(nextRetryAt - f.clock.now);
  }
  assert.equal(f.link.view().state.status, 'reconnecting');
  f.link.attemptNow();
  await settle();
  const state = f.link.view().state;
  assert.equal(state.status, 'lost');
  assert.equal(state.code, 'unreachable');
});

test('the Reconnect now IPC skips the countdown of the sender’s connection only', async () => {
  const { registerConnectionLinkIpc } = await import('./link-ipc.ts');
  const { WindowRouteRegistry } = await import('./window-routes.ts');
  const skipped = [];
  const connection = (id) => ({
    id,
    kind: 'ssh',
    link: { attemptNow: () => skipped.push(id), view: () => ({ state: { status: 'reconnecting' } }) },
    reconnect: async () => {},
  });
  const pool = new ConnectionPool();
  pool.add(connection('srv-a'));
  pool.add(connection('srv-b'));
  const routes = new WindowRouteRegistry();
  routes.register({ id: 11, once: () => {} }, 'srv-a');
  routes.register({ id: 12, once: () => {} }, 'srv-b');
  const handlers = new Map();
  registerConnectionLinkIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: () => {} },
    routes,
    pool,
    restore: { isEnabled: () => true, setEnabled: () => true, progress: () => null },
    closeWindow: () => {},
    showConnectionSettings: () => {},
    requestSignIn: () => {},
  });
  await handlers.get(DESKTOP_IPC.connectionRetryNow)({ sender: { id: 12 } });
  assert.deepEqual(skipped, ['srv-b']);
  await assert.rejects(handlers.get(DESKTOP_IPC.connectionRetryNow)({ sender: { id: 99 } }));
  assert.deepEqual(skipped, ['srv-b']);
});

test('a tunnel stopped for good (refused login) turns the attempt into a terminal loss', async () => {
  let stopped = null;
  const f = linkFixture({ probe: () => null, stoppedBy: () => stopped });
  f.link.start();
  f.link.serviceLost();
  await f.clock.advance(1_000);
  assert.equal(f.link.view().state.status, 'reconnecting');
  stopped = { code: 'auth', message: 'Permission denied (publickey).', settingsRequired: true };
  await f.clock.advance(2_000);
  assert.deepEqual(f.link.view().state, {
    status: 'lost',
    terminal: true,
    code: 'auth',
    message: 'Permission denied (publickey).',
    settingsRequired: true,
  });
  assert.deepEqual(f.calls, ['reviveTunnel'], 'nothing is dialed after the refusal');
});

test('with automatic reconnection off a drop is lost at once; only Reconnect dials', async () => {
  let reachable = false;
  const f = linkFixture({ autoReconnect: false, probe: () => (reachable ? 6 : null) });
  f.link.start();
  f.link.serviceLost();
  assert.deepEqual(f.link.view().state, {
    status: 'lost',
    terminal: false,
    code: 'auto-reconnect-off',
    message: 'Automatic reconnection is off for this server.',
  });
  assert.deepEqual(f.calls, ['hold'], 'dials are refused until the user reconnects');
  await f.clock.advance(5 * 60_000);
  assert.deepEqual(f.calls, ['hold'], 'nothing is attempted on its own');
  // The user's Reconnect: dials allowed, the tunnel and service try once.
  reachable = false;
  f.link.retry();
  await settle();
  assert.deepEqual(f.calls, ['hold', 'release', 'reviveTunnel', 'retryService']);
  assert.equal(f.link.view().state.status, 'reconnecting');
  f.link.serviceRestored();
  assert.equal(f.link.view().state.status, 'connected');
  // Health failures do not replace the tunnel either.
  await f.clock.advance(LINK_HEALTH_INTERVAL_MS * LINK_FAILURE_LIMIT);
  assert.ok(!f.calls.includes('resetTunnel'));
  assert.equal(f.link.view().state.status, 'lost');
});

test('a reachable daemon behind a dropped service makes the client retry now', async () => {
  const f = linkFixture();
  f.link.start();
  f.link.serviceLost();
  await f.clock.advance(1_000);
  assert.deepEqual(f.calls, ['retryService']);
  assert.equal(f.link.view().rttMs, 12);
  assert.equal(f.link.view().state.status, 'reconnecting', 'connected only once the service is back');
});

test('backoff is capped inside the server grace window and starts over after 60 s healthy', async () => {
  assert.equal(remoteClientGraceMs(''), REMOTE_CLIENT_GRACE_DEFAULT_MS);
  assert.equal(remoteClientGraceMs(undefined), REMOTE_CLIENT_GRACE_DEFAULT_MS);
  assert.equal(remoteClientGraceMs('400'), 400);
  assert.equal(reconnectDelayCapMs(REMOTE_CLIENT_GRACE_DEFAULT_MS), RECONNECT_MAX_DELAY_MS);
  // A short grace still fits several attempts.
  assert.equal(reconnectDelayCapMs(60_000), 10_000);
  assert.ok(reconnectDelayCapMs(60_000) * 6 <= 60_000);

  const ladder = new ReconnectLadder(reconnectDelayCapMs(REMOTE_CLIENT_GRACE_DEFAULT_MS));
  const delays = [];
  for (let index = 0; index < 10; index += 1) delays.push(ladder.next(0).delayMs);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
  // Flapping (healthy less than 60 s) keeps climbing; a stable link resets.
  ladder.markHealthy(100_000);
  assert.equal(ladder.next(100_000 + LINK_STABLE_RESET_MS - 1).attempt, 11);
  ladder.markHealthy(200_000);
  assert.deepEqual(ladder.next(200_000 + LINK_STABLE_RESET_MS), { attempt: 1, delayMs: 1_000 });

  // Past the grace the link is lost (not terminal): the countdown stops.
  const f = linkFixture({ graceMs: 20_000, probe: () => null });
  f.link.start();
  f.link.serviceLost();
  await f.clock.advance(25_000);
  const state = f.link.view().state;
  assert.equal(state.status, 'lost');
  assert.equal(state.terminal, false);
  assert.equal(state.code, 'unreachable');
  // The user's Reconnect starts counting again.
  f.link.retry();
  await settle();
  assert.equal(f.link.view().state.status, 'reconnecting');
});

test('a link attempt makes the service client reconnect now instead of waiting out its delay', async () => {
  const transports = [];
  const client = new DesktopServiceClient({
    connect: () => {
      const transport = new EventEmitter();
      transport.postMessage = () => {};
      transport.close = async () => {};
      transports.push(transport);
      return transport;
    },
    sessionOptions: () => ({}),
    startupTimeoutMs: 600_000,
    restartBaseDelayMs: 60_000,
    restartMaxDelayMs: reconnectDelayCapMs(REMOTE_CLIENT_GRACE_DEFAULT_MS),
  });
  const ready = client.start();
  assert.equal(transports.length, 1);
  transports[0].emit('exit', 1);
  assert.equal(transports.length, 1, 'the restart waits out its delay');
  const retried = client.retryNow();
  assert.equal(transports.length, 2, 'retryNow dials at once');
  transports[1].emit('message', { kind: 'ready', viewSync: false });
  await Promise.all([ready, retried]);
  assert.equal(client.terminalFailure, null);
  await client.dispose();
});

test('sleep pauses the link; resume probes twice before touching the tunnel', async () => {
  // A live link after sleep: two probes at most, nothing restarted.
  let answers = [null, 9];
  const f = linkFixture({ probe: () => (answers.length ? answers.shift() : 9) });
  f.link.start();
  f.link.suspend();
  assert.deepEqual(f.link.view().state, { status: 'paused' });
  await f.clock.advance(5 * LINK_HEALTH_INTERVAL_MS);
  assert.equal(f.probes.length, 0, 'no probes while asleep');
  await f.link.resume();
  assert.deepEqual(f.probes, [LINK_PROBE_TIMEOUT_MS, LINK_PROBE_TIMEOUT_MS]);
  assert.deepEqual(f.calls, [], 'a live link is never torn down');
  assert.deepEqual(f.link.view().state, { status: 'connected' });
  assert.equal(f.link.view().rttMs, 9);

  // A dead link after sleep: the ssh child is replaced, the backoff starts over.
  answers = [null, null];
  const g = linkFixture({ probe: () => (answers.length ? answers.shift() : null) });
  g.link.start();
  g.link.serviceLost();
  await g.clock.advance(1_000 + 2_000 + 4_000);
  assert.equal(g.link.view().state.attempt, 4);
  g.link.suspend();
  assert.equal(g.link.view().state.status, 'paused');
  g.calls.length = 0;
  await g.link.resume();
  assert.deepEqual(g.calls, ['resetTunnel']);
  assert.equal(g.link.view().state.status, 'reconnecting');
  assert.equal(g.link.view().state.attempt, 1, 'backoff reset');
});

test('health probe every 15 s; three failures inside 60 s reset the tunnel', async () => {
  let healthy = true;
  const f = linkFixture({ probe: () => (healthy ? 7 : null) });
  f.link.start();
  await f.clock.advance(LINK_HEALTH_INTERVAL_MS);
  assert.equal(f.probes.length, 1);
  assert.equal(f.link.view().rttMs, 7, 'the round trip reaches the window');
  healthy = false;
  await f.clock.advance(LINK_HEALTH_INTERVAL_MS * (LINK_FAILURE_LIMIT - 1));
  assert.deepEqual(f.calls, [], 'two failures are tolerated');
  assert.equal(f.link.view().state.status, 'connected');
  await f.clock.advance(LINK_HEALTH_INTERVAL_MS);
  assert.deepEqual(f.calls, ['resetTunnel']);
  assert.equal(f.link.view().state.status, 'reconnecting');
  // Probes recover: connected (the service never dropped).
  healthy = true;
  await f.clock.advance(1_000);
  assert.equal(f.link.view().state.status, 'connected');

  // Failures spread wider than 60 s never add up.
  const g = linkFixture({ probe: (count) => (count % 3 === 0 ? null : 5) });
  g.link.start();
  await g.clock.advance(LINK_HEALTH_INTERVAL_MS * 12);
  assert.deepEqual(g.calls, []);
});

/** Adds `listener` to `set`; the returned function removes it. */
function subscribeTo(set, listener) {
  set.add(listener);
  return () => set.delete(listener);
}

/** Calls every listener in `set` with `value`. */
function publishTo(set, value) {
  for (const listener of set) listener(value);
}

test('re-attach report: finished and continued turns, interrupted model calls, outcome-unknown tools', async () => {
  const clock = fakeTimers();
  const listeners = { sessions: new Set(), states: new Set(), link: new Set() };
  const notices = [];
  const report = createReattachReport({
    sources: {
      subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
      subscribeSessionStates: (listener) => subscribeTo(listeners.states, listener),
      subscribeLink: (listener) => subscribeTo(listeners.link, listener),
    },
    emit: (notice) => notices.push(notice),
    now: clock.timers.now,
    setTimeout: clock.timers.setTimeout,
    clearTimeout: clock.timers.clearTimeout,
  });
  const sessions = (rows) => publishTo(listeners.sessions, rows);
  const state = (sessionId, snapshot, frameSource = 'live') =>
    publishTo(listeners.states, { sessionId, snapshot, frameSource });
  const link = (status) =>
    publishTo(listeners.link, {
      connectionId: 'srv',
      state: { status, attempt: 1, nextRetryAt: null },
      rttMs: null,
      terminalsAvailable: true,
    });
  sessions([
    { id: 'a', title: 'Build', working: true },
    { id: 'b', title: 'Deploy', working: true },
    { id: 'c', title: 'Idle', working: false },
  ]);
  state('a', {
    busy: true,
    items: [
      { id: 't1', kind: 'tool' },
      { id: 't2', kind: 'tool', result: 'ok' },
    ],
  });
  link('reconnecting');
  report.onModelCall({ provider: 'openai', outcome: 'undelivered' });
  report.onModelCall({ provider: 'openai', outcome: 'answered' });
  link('connected');
  assert.deepEqual(notices, [], 'waits for the fresh session list');
  sessions([
    { id: 'a', title: 'Build', working: false },
    { id: 'b', title: 'Deploy', working: true },
    { id: 'c', title: 'Idle', working: false },
  ]);
  assert.deepEqual(notices, [
    { kind: 'reattached', finished: ['Build'], continued: ['Deploy'], interruptedModelCalls: 1 },
  ]);
  // The turn that ran t1 is over and t1 never got its result: outcome unknown.
  state('a', { busy: true, items: [{ id: 't1', kind: 'tool' }] });
  assert.equal(notices.length, 1, 'still running: the result may yet come');
  state('a', {
    busy: false,
    items: [
      { id: 't1', kind: 'tool' },
      { id: 't2', kind: 'tool', result: 'ok' },
    ],
  });
  assert.deepEqual(notices[1], { kind: 'outcome-unknown', sessionId: 'a', toolIds: ['t1'] });
  // Nothing to report after a quiet outage; the stale list is used after the wait.
  sessions([{ id: 'b', title: 'Deploy', working: false }]);
  link('reconnecting');
  link('connected');
  await clock.advance(REATTACH_SESSIONS_WAIT_MS);
  assert.equal(notices.length, 2);
  report.dispose();
});

test('a server window notifies on this PC: labeled final answers, approvals, link lost and restored', async () => {
  const clock = fakeTimers();
  const listeners = { sessions: new Set(), agents: new Set(), states: new Set(), link: new Set() };
  const shown = [];
  const focused = [];
  let foreground = false;
  const notifier = createServerNotifier({
    serverName: 'Box',
    sources: {
      subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
      subscribeAgentPool: (listener) => subscribeTo(listeners.agents, listener),
      subscribeSessionStates: (listener) => subscribeTo(listeners.states, listener),
      subscribeLink: (listener) => subscribeTo(listeners.link, listener),
      readFinalAnswer: async () => null,
    },
    preferences: () => ({ preferences: DEFAULT_NOTIFICATION_PREFERENCES, overrides: [] }),
    isSupported: () => true,
    isForeground: () => foreground,
    isSessionOnScreen: () => foreground,
    createNotification: (content) => {
      const handlers = {};
      const notification = {
        content,
        on: (event, listener) => {
          handlers[event] = listener;
          return notification;
        },
        show: () => shown.push(notification),
        close: () => {},
        click: () => handlers.click?.(),
      };
      return notification;
    },
    focus: (sessionId) => focused.push(sessionId ?? null),
    text: {
      approvalWaiting: () => 'A tool is waiting for your approval.',
      lostTitle: () => 'Connection to {{name}} lost',
      lostReconnecting: () => 'Mixdog is reconnecting automatically.',
      lostStopped: () => 'Open the server window to reconnect.',
      restoredTitle: () => 'Reconnected to {{name}}',
      restoredBody: () => 'The server window is working again.',
    },
    diagnostic: () => {},
    setTimeout: clock.timers.setTimeout,
    clearTimeout: clock.timers.clearTimeout,
  });
  const emit = publishTo;
  const link = (state) => emit(listeners.link, { connectionId: 'srv', state, rttMs: null, terminalsAvailable: true });
  emit(listeners.sessions, [{ id: 's1', title: 'Refactor', working: true }]);
  // Approval: a new wait notifies once, labeled with the server, and a click
  // opens that session in the server's window. A replay does not.
  emit(listeners.states, { sessionId: 's1', snapshot: { toolApproval: { id: 'ap1' } }, frameSource: 'replay' });
  assert.equal(shown.length, 0);
  emit(listeners.states, { sessionId: 's1', snapshot: { toolApproval: null }, frameSource: 'live' });
  emit(listeners.states, { sessionId: 's1', snapshot: { toolApproval: { id: 'ap2' } }, frameSource: 'live' });
  emit(listeners.states, { sessionId: 's1', snapshot: { toolApproval: { id: 'ap2' } }, frameSource: 'live' });
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].content, { title: 'Box · Refactor', body: 'A tool is waiting for your approval.' });
  shown[0].click();
  assert.deepEqual(focused, ['s1']);
  // Link: a short blip says nothing; a lasting drop does, then the recovery.
  link({ status: 'reconnecting', attempt: 1, nextRetryAt: null });
  link({ status: 'connected' });
  await clock.advance(LINK_LOST_NOTICE_DELAY_MS);
  assert.equal(shown.length, 1);
  link({ status: 'reconnecting', attempt: 1, nextRetryAt: null });
  await clock.advance(LINK_LOST_NOTICE_DELAY_MS);
  assert.equal(shown.at(-1).content.title, 'Connection to Box lost');
  link({ status: 'connected' });
  assert.equal(shown.at(-1).content.title, 'Reconnected to Box');
  shown.at(-1).click();
  assert.deepEqual(focused, ['s1', null], 'a link notice brings the window, no session');
  // Sleep is not a loss; a focused window is not notified.
  link({ status: 'paused' });
  link({ status: 'reconnecting', attempt: 1, nextRetryAt: null });
  await clock.advance(LINK_LOST_NOTICE_DELAY_MS);
  link({ status: 'connected' });
  foreground = true;
  link({ status: 'lost', terminal: true, code: 'auth', message: 'denied' });
  assert.equal(shown.length, 3);
  notifier.dispose();
});

test('a focused server window showing session A still notifies an approval in session B', () => {
  const listeners = { sessions: new Set(), agents: new Set(), states: new Set(), link: new Set() };
  const shown = [];
  const notifier = createServerNotifier({
    serverName: 'Box',
    sources: {
      subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
      subscribeAgentPool: (listener) => subscribeTo(listeners.agents, listener),
      subscribeSessionStates: (listener) => subscribeTo(listeners.states, listener),
      subscribeLink: (listener) => subscribeTo(listeners.link, listener),
      readFinalAnswer: async () => null,
    },
    preferences: () => ({ preferences: DEFAULT_NOTIFICATION_PREFERENCES, overrides: [] }),
    isSupported: () => true,
    isForeground: () => true,
    isSessionOnScreen: (sessionId) => sessionId === 'a',
    createNotification: (content) => {
      const notification = { content, on: () => notification, show: () => shown.push(content), close: () => {} };
      return notification;
    },
    focus: () => {},
    text: {
      approvalWaiting: () => 'waiting',
      lostTitle: () => '',
      lostReconnecting: () => '',
      lostStopped: () => '',
      restoredTitle: () => '',
      restoredBody: () => '',
    },
    diagnostic: () => {},
  });
  publishTo(listeners.sessions, [
    { id: 'a', title: 'Shown' },
    { id: 'b', title: 'Elsewhere' },
  ]);
  publishTo(listeners.states, { sessionId: 'a', snapshot: { toolApproval: { id: 'ap1' } }, frameSource: 'live' });
  publishTo(listeners.states, { sessionId: 'b', snapshot: { toolApproval: { id: 'ap2' } }, frameSource: 'live' });
  assert.deepEqual(
    shown.map((content) => content.title),
    ['Box · Elsewhere']
  );
  notifier.dispose();
});

test('a server approval for a session titled by attachments alone names its kind, not [Image]', () => {
  const listeners = { sessions: new Set(), agents: new Set(), states: new Set(), link: new Set() };
  const shown = [];
  const notifier = createServerNotifier({
    serverName: 'Box',
    sources: {
      subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
      subscribeAgentPool: (listener) => subscribeTo(listeners.agents, listener),
      subscribeSessionStates: (listener) => subscribeTo(listeners.states, listener),
      subscribeLink: (listener) => subscribeTo(listeners.link, listener),
      readFinalAnswer: async () => null,
    },
    preferences: () => ({ preferences: DEFAULT_NOTIFICATION_PREFERENCES, overrides: [] }),
    isSupported: () => true,
    isForeground: () => false,
    isSessionOnScreen: () => false,
    createNotification: (content) => {
      const notification = { content, on: () => notification, show: () => shown.push(content), close: () => {} };
      return notification;
    },
    focus: () => {},
    text: {
      approvalWaiting: () => '도구가 승인을 기다리고 있습니다.',
      lostTitle: () => '',
      lostReconnecting: () => '',
      lostStopped: () => '',
      restoredTitle: () => '',
      restoredBody: () => '',
    },
    titleLabels: () => ({ image: '이미지', video: '영상', file: '파일' }),
    diagnostic: () => {},
  });
  publishTo(listeners.sessions, [{ id: 's1', title: '[Image]' }]);
  publishTo(listeners.states, { sessionId: 's1', snapshot: { toolApproval: { id: 'ap1' } }, frameSource: 'live' });
  assert.deepEqual(shown, [{ title: 'Box · 이미지', body: '도구가 승인을 기다리고 있습니다.' }]);
  notifier.dispose();
});

test('a server window follows this PC’s preferences: a muted bot, approvals off, notifications off', () => {
  const listeners = { sessions: new Set(), agents: new Set(), states: new Set(), link: new Set() };
  const shown = [];
  const diagnostics = [];
  const view = { preferences: DEFAULT_NOTIFICATION_PREFERENCES, overrides: [] };
  const notifier = createServerNotifier({
    serverName: 'Box',
    sources: {
      subscribeSessions: (listener) => subscribeTo(listeners.sessions, listener),
      subscribeAgentPool: (listener) => subscribeTo(listeners.agents, listener),
      subscribeSessionStates: (listener) => subscribeTo(listeners.states, listener),
      subscribeLink: (listener) => subscribeTo(listeners.link, listener),
      readFinalAnswer: async () => null,
    },
    preferences: () => view,
    isSupported: () => true,
    isForeground: () => false,
    isSessionOnScreen: () => false,
    createNotification: (content) => {
      const notification = { content, on: () => notification, show: () => shown.push(content), close: () => {} };
      return notification;
    },
    focus: () => {},
    text: {
      approvalWaiting: () => 'waiting',
      lostTitle: () => 'lost',
      lostReconnecting: () => '',
      lostStopped: () => '',
      restoredTitle: () => '',
      restoredBody: () => '',
    },
    diagnostic: (event, details) => diagnostics.push([event, details.sessionId, details.reason]),
  });
  publishTo(listeners.sessions, [
    { id: 'home', title: 'Reviewer', agentHome: 'reviewer' },
    { id: 'code', title: 'Fix' },
  ]);
  const ask = (sessionId, id) =>
    publishTo(listeners.states, { sessionId, snapshot: { toolApproval: { id } }, frameSource: 'live' });
  view.overrides = [{ target: { kind: 'agent', id: 'reviewer' }, setting: { mode: 'muted', until: null } }];
  ask('home', 'a1');
  ask('code', 'a2');
  assert.deepEqual(
    shown.map((content) => content.title),
    ['Box · Fix']
  );
  view.preferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, approval: false },
  };
  ask('code', 'a3');
  view.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, scope: 'off' };
  publishTo(listeners.link, { connectionId: 'srv', state: { status: 'lost', terminal: true }, rttMs: null });
  assert.equal(shown.length, 1);
  assert.deepEqual(
    diagnostics.filter(([event]) => event === 'server-approval-notification-suppressed'),
    [
      ['server-approval-notification-suppressed', 'home', 'muted'],
      ['server-approval-notification-suppressed', 'code', 'event'],
    ]
  );
  notifier.dispose();
});

test('server windows open at quit are reopened at launch; a removed server is skipped', async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-restore-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  const opened = [];
  const progress = [];
  let saved = [
    { id: 'a', name: 'Alpha', target: 'root@a' },
    { id: 'b', name: 'Beta', target: 'root@b' },
  ];
  const make = () =>
    createServerWindowRestore({
      userDataPath,
      savedServers: async () => saved,
      open: async (spec, onProgress) => {
        opened.push(spec);
        onProgress({ phase: 'check' });
        if (spec.id === 'b') throw new RemoteBootstrapError('node-missing', 'node is missing');
      },
      onProgress: (entry) => progress.push(entry),
    });
  const first = make();
  assert.equal(await first.isEnabled(), true, 'on by default');
  await first.remember('a');
  await first.remember('b');
  await first.remember('gone');
  await first.forget('gone');
  await first.remember('c');
  assert.deepEqual(JSON.parse(await readFile(join(userDataPath, SERVER_WINDOWS_FILE), 'utf8')).open, ['a', 'b', 'c']);

  // Next launch: 'c' was removed from the saved list meanwhile.
  const second = make();
  await second.restore();
  assert.deepEqual(opened, [
    { id: 'a', name: 'Alpha', target: 'root@a' },
    { id: 'b', name: 'Beta', target: 'root@b' },
  ]);
  assert.deepEqual(
    progress.filter((entry) => entry.id === 'a').map((entry) => entry.phase),
    ['connect', 'check', 'ready']
  );
  assert.deepEqual(progress.filter((entry) => entry.id === 'b').at(-1), {
    id: 'b',
    name: 'Beta',
    phase: 'failed',
    message: 'node is missing',
  });
  assert.deepEqual(JSON.parse(await readFile(join(userDataPath, SERVER_WINDOWS_FILE), 'utf8')).open, ['a', 'b']);
  // A window that subscribes late still learns which reopening failed.
  assert.deepEqual(second.progress(), [{ id: 'b', name: 'Beta', phase: 'failed', message: 'node is missing' }]);

  // The setting off: nothing reopens.
  await second.setEnabled(false);
  opened.length = 0;
  saved = [...saved];
  await make().restore();
  assert.deepEqual(opened, []);
});

test('terminal link failures name the confirmation they need; sign-in failures are recognized', () => {
  const auth = describeLinkFailure(
    new SshError('ssh failed:\nPermission denied (publickey).', 'terminal', 'Permission denied (publickey).'),
    'root@127.0.0.1:2223'
  );
  assert.equal(auth.code, 'auth');
  assert.equal(auth.settingsRequired, true);
  const node = describeLinkFailure(new RemoteBootstrapError('node-missing', 'node is missing'), 'root@host');
  assert.equal(node.settingsRequired, undefined);
  assert.equal(node.message, 'node is missing');
  assert.equal(isSignInFailure(Object.assign(new Error('expired'), { reauthRequired: true })), true);
  assert.equal(isSignInFailure(Object.assign(new Error('401'), { status: 401 })), true);
  assert.equal(isSignInFailure(new Error('rate limited')), false);
});

test('a confirmed forced restart reaches the new connection only', async () => {
  const pool = new ConnectionPool();
  const made = [];
  const manager = createConnectionManager({
    pool,
    createConnection: (spec, _onProgress, options) => {
      made.push(options?.forceRestart === true);
      return { id: spec.id, kind: 'ssh', start: async () => {}, dispose: async () => {} };
    },
    showWindow: () => {},
    closeWindows: () => {},
  });
  await manager.open({ id: 'srv-f', name: 'Box', target: 'root@127.0.0.1:2223' }, undefined, { forceRestart: true });
  await manager.close('srv-f');
  await manager.open({ id: 'srv-f', name: 'Box', target: 'root@127.0.0.1:2223' });
  assert.deepEqual(made, [true, false]);
});

test('a user connect to a stopped server window reopens it in place instead of a new connection', async () => {
  const pool = new ConnectionPool();
  let created = 0;
  let stopped = true;
  const reconnects = [];
  const manager = createConnectionManager({
    pool,
    createConnection: (spec) => {
      created += 1;
      return {
        id: spec.id,
        kind: 'ssh',
        start: async () => {},
        dispose: async () => {},
        stopped: () => stopped,
        reconnect: async () => {
          reconnects.push(spec.id);
          if (reconnects.length === 1)
            throw Object.assign(new Error('exit'), { cause: new SshError('Permission denied', 'terminal') });
          stopped = false;
        },
      };
    },
    showWindow: () => {},
    closeWindows: () => {},
  });
  stopped = false;
  await manager.open({ id: 'srv-r', name: 'Box', target: 'root@127.0.0.1:2223' });
  stopped = true;
  await assert.rejects(manager.open({ id: 'srv-r', name: 'Box', target: 'root@127.0.0.1:2223' }), SshError);
  assert.equal(manager.isOpen('srv-r'), true, 'the window keeps its (stopped) connection');
  await manager.open({ id: 'srv-r', name: 'Box', target: 'root@127.0.0.1:2223' });
  assert.equal(created, 1);
  assert.deepEqual(reconnects, ['srv-r', 'srv-r']);
});

test('the daemon behind the tunnel must be the probed one, and no token is sent to check it', async (t) => {
  const seen = [];
  let answer = { status: 'ok', pid: 41, buildHash: 'abc123' };
  const server = createServer((request, response) => {
    seen.push({ url: request.url, token: request.headers['x-mixdog-daemon-token'] ?? null });
    response.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const health = await readDaemonHealth(port, 2_000);
  assert.equal(health.pid, 41);
  assert.equal(health.buildHash, 'abc123');
  assert.equal(isExpectedDaemon(health, { pid: 41, buildHash: 'abc123' }), true);
  assert.equal(isExpectedDaemon(health, { pid: 41, buildHash: null }), true, 'the probe named no build: pid decides');
  assert.equal(isExpectedDaemon(health, { pid: 42, buildHash: 'abc123' }), false, 'another process on the freed port');
  assert.equal(isExpectedDaemon(health, { pid: 41, buildHash: 'zzz' }), false, 'another build');
  answer = { status: 'starting', pid: 41 };
  assert.equal(await readDaemonHealth(port, 2_000), null);
  assert.deepEqual(
    seen.map((entry) => entry.token),
    [null, null]
  );
  assert.equal(daemonIdentityError('root@host').kind, 'terminal');
});

test('server notifications are bounded and keep the server label first', () => {
  const long = 'x'.repeat(500);
  const bounded = boundedNotification({ title: `Box · ${long}\nsecond`, body: long });
  assert.equal([...bounded.title].length, NOTIFICATION_TITLE_CHARS);
  assert.ok(bounded.title.startsWith('Box · '));
  assert.ok(bounded.title.endsWith('…'));
  assert.ok(!bounded.title.includes('\n'));
  assert.equal([...bounded.body].length, NOTIFICATION_BODY_CHARS);
});

test('link state and notices reach only the window they are forwarded to, until it closes', () => {
  const listeners = new Set();
  const noticeListeners = new Set();
  const connection = {
    link: { subscribe: (listener) => subscribeTo(listeners, listener) },
    subscribeNotices: (listener) => subscribeTo(noticeListeners, listener),
  };
  const sent = [];
  const stop = forwardConnectionLink(connection, { isDestroyed: () => false, send: (...args) => sent.push(args) });
  publishTo(listeners, { state: { status: 'paused' } });
  publishTo(noticeListeners, { kind: 'model-sign-in', provider: 'anthropic' });
  assert.deepEqual(sent, [
    [DESKTOP_IPC.connectionLinkState, { state: { status: 'paused' } }],
    [DESKTOP_IPC.connectionNotice, { kind: 'model-sign-in', provider: 'anthropic' }],
  ]);
  stop();
  assert.equal(listeners.size + noticeListeners.size, 0);
});
