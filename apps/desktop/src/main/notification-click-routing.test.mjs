import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopTurnNotifier } from './desktop-turn-notifier.ts';
import { createPrimaryWindowActivation, retainNotification } from './notification-window.ts';
import { createHeldChannel } from '../preload/held-ipc.ts';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../shared/contract-notifications.ts';

/** A window that records what reaches it; `mode` is how the user left it. */
function fakeWindow(mode = 'visible') {
  const state = { mode, calls: [] };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => state.mode === 'minimized',
    isVisible: () => state.mode !== 'hidden',
    restore: () => state.calls.push('restore'),
    show: () => state.calls.push('show'),
    focus: () => state.calls.push('focus'),
    webContents: { isDestroyed: () => false, send: (...args) => state.calls.push(args) },
  };
  return { window, state };
}

// The notifier's collaborators are promise-only fakes, so everything a tick
// sets going is microtasks; the event loop reaches its next macrotask (the
// real setImmediate, not faked here) only once all of them have run.
const drained = () => new Promise((resolve) => setImmediate(resolve));

const sent = (state) => state.calls.filter(Array.isArray);

/** The real notifier and the real click route; only Electron is faked. */
function harness(t, { windows }) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const notifications = [];
  let recreated = 0;
  let current = windows.initial;
  const activation = createPrimaryWindowActivation(
    () => current,
    () => {
      recreated++;
    }
  );
  const notifier = createDesktopTurnNotifier({
    preferences: () => ({
      preferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, error: true },
      },
      overrides: [],
    }),
    isSupported: () => true,
    isSessionOnScreen: () => false,
    readFinalAnswer: async (id) =>
      id.startsWith('failing')
        ? { id: 'turn', at: Date.now(), status: 'failed', text: '' }
        : { id: 'turn', at: Date.now(), status: 'done', text: 'finished the work' },
    createNotification: (content) => {
      const notification = new EventEmitter();
      Object.assign(notification, { content, show() {}, close() {} });
      notifications.push(notification);
      return notification;
    },
    openSession: (id) => activation.activate(id),
    diagnostic: () => {},
  });
  t.after(() => notifier.dispose());
  const finish = async (rows) => {
    notifier.onSessions(rows.map((row) => ({ title: 'T', ...row, working: true })));
    notifier.onSessions(rows.map((row) => ({ title: 'T', ...row })));
    t.mock.timers.tick(2_500);
    await drained();
  };
  return {
    notifier,
    notifications,
    activation,
    finish,
    setWindow: (next) => {
      current = next;
    },
    recreated: () => recreated,
  };
}

const KINDS = [
  ['coding session', { id: 'code-1' }],
  ['bot home chat', { id: 'bot-1', agentHome: 'secretary' }],
  ['group room', { id: 'room-1', agentRoom: { name: 'Planning' } }],
  ['failed turn', { id: 'failing-1' }],
];

for (const [name, row] of KINDS) {
  for (const mode of ['visible', 'minimized', 'hidden']) {
    test(`clicking the ${name} notification with the window ${mode} sends its session to the renderer`, async (t) => {
      const { window, state } = fakeWindow(mode);
      const h = harness(t, { windows: { initial: window } });
      await h.finish([row]);
      assert.equal(h.notifications.length, 1);
      h.notifications[0].emit('click');
      assert.deepEqual(sent(state), [[DESKTOP_IPC.notificationOpenSession, row.id]]);
      // The window is raised before the renderer is told.
      assert.equal(state.calls.at(-2), 'focus');
      if (mode === 'minimized') assert.ok(state.calls.includes('restore'));
      if (mode === 'hidden') assert.ok(state.calls.includes('show'));
    });
  }
}

test('approval and question waits open the chat that shows them, a sub-agent’s included', async (t) => {
  const { window, state } = fakeWindow('hidden');
  const h = harness(t, { windows: { initial: window } });
  h.notifier.onSessions([
    { id: 'code-1', title: 'T' },
    { id: 'sub-1', title: 'Worker' },
    { id: 'bot-1', title: '', agentHome: 'secretary' },
  ]);
  h.notifier.onSessionState({
    sessionId: 'sub-1',
    frameSource: 'live',
    snapshot: { toolApproval: { id: 'a1', kind: 'approval', surfaceSessionId: 'code-1' } },
  });
  h.notifier.onSessionState({
    sessionId: 'bot-1',
    frameSource: 'live',
    snapshot: { toolApproval: { id: 'q1', kind: 'question' } },
  });
  t.mock.timers.tick(0);
  await drained();
  assert.equal(h.notifications.length, 2);
  for (const notification of h.notifications) notification.emit('click');
  assert.deepEqual(
    sent(state).map((call) => call[1]),
    ['code-1', 'bot-1']
  );
});

test('a click with no window rebuilds it and delivers the session once it exists', async (t) => {
  const h = harness(t, { windows: { initial: null } });
  await h.finish([{ id: 'room-1', agentRoom: { name: 'Planning' } }]);
  h.notifications[0].emit('click');
  assert.equal(h.recreated(), 1, 'the window is asked for again');
  const { window, state } = fakeWindow('hidden');
  h.setWindow(window);
  h.activation.flush();
  assert.deepEqual(sent(state), [[DESKTOP_IPC.notificationOpenSession, 'room-1']]);
  h.activation.flush();
  assert.equal(sent(state).length, 1, 'delivered exactly once');
});

test('a plain activation never drops the session a click is waiting to open', () => {
  let current = null;
  const activation = createPrimaryWindowActivation(() => current);
  activation.activate('bot-1');
  activation.activate();
  const { window, state } = fakeWindow('visible');
  current = window;
  activation.flush();
  assert.deepEqual(sent(state), [[DESKTOP_IPC.notificationOpenSession, 'bot-1']]);
});

test('a plain activation that finds the window first still delivers the remembered session', () => {
  let current = null;
  const activation = createPrimaryWindowActivation(() => current);
  activation.activate('room-1');
  const { window, state } = fakeWindow('hidden');
  current = window;
  activation.activate();
  assert.deepEqual(sent(state), [[DESKTOP_IPC.notificationOpenSession, 'room-1']]);
  activation.flush();
  activation.activate();
  assert.equal(sent(state).length, 1, 'consumed once');
});

test('a notification stays referenced until it is clicked, closed or failed', () => {
  const live = new Set();
  const make = () => {
    const notification = new EventEmitter();
    retainNotification(live, notification);
    return notification;
  };
  const clicked = make();
  const closed = make();
  const failed = make();
  const open = make();
  assert.equal(live.size, 4, 'held while the toast can still be clicked');
  clicked.emit('click');
  closed.emit('close');
  failed.emit('failed');
  assert.deepEqual([...live], [open]);
});

test('a session named before the renderer subscribes is held for its first listener only', () => {
  const channel = createHeldChannel();
  channel.push('older');
  channel.push('newest');
  const first = [];
  const stop = channel.subscribe((id) => first.push(id));
  assert.deepEqual(first, ['newest']);
  channel.push('live');
  assert.deepEqual(first, ['newest', 'live']);
  stop();
  const second = [];
  channel.subscribe((id) => second.push(id));
  assert.deepEqual(second, [], 'a consumed click is not replayed');
});
