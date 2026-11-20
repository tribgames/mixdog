import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  createPrimaryWindowActivation,
  openDesktopNotificationSession,
  retainNotification,
} from './notification-window.ts';
import { createHeldChannel } from '../preload/held-ipc.ts';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';

// The host's toast presenter reads Electron's types at import; outside Electron this stand-in answers.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export default "";export const BrowserWindow = {};', shortCircuit: true }
      : next(specifier, context);
  },
});
const { registerNotificationHost } = await import('./host/notification.ts');

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

const sent = (state) => state.calls.filter(Array.isArray);

/** The real host presenter and the real click route; only Electron is faked. The core's `host/notification/show` is what a toast is. */
function harness(t, { windows }) {
  const notifications = [];
  let recreated = 0;
  let current = windows.initial;
  const activation = createPrimaryWindowActivation(
    () => current,
    () => {
      recreated++;
    }
  );
  const handlers = new Map();
  registerNotificationHost(
    {
      handleNotification: (method, handler) => handlers.set(method, handler),
      handleRequest: (method, handler) => handlers.set(method, handler),
      notify: () => {},
    },
    {
      createNotification: (content) => {
        const notification = new EventEmitter();
        Object.assign(notification, { content, show() {}, close() {} });
        notifications.push(notification);
        return notification;
      },
      activate: (sessionId) => activation.activate(sessionId),
      isSupported: () => true,
      idleSeconds: () => 0,
    }
  );
  /** The core tells a toast for each of `rows`. */
  const finish = (rows) => {
    for (const row of rows)
      handlers.get('host/notification/show')({ title: 'T', body: 'finished the work', threadId: row.id });
  };
  return {
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
  ['approval or question wait, a sub-agent’s included (the core names the chat that shows it)', { id: 'code-1' }],
];

for (const [name, row] of KINDS) {
  for (const mode of ['visible', 'minimized', 'hidden']) {
    test(`clicking the ${name} notification with the window ${mode} sends its session to the renderer`, async (t) => {
      const { window, state } = fakeWindow(mode);
      const h = harness(t, { windows: { initial: window } });
      h.finish([row]);
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

for (const mode of ['hidden', 'minimized', 'visible']) {
  test(`a notification click restores/focuses the ${mode} window before sending the exact session`, () => {
    const { window, state } = fakeWindow(mode);
    assert.equal(openDesktopNotificationSession(window, 'exact-background-session'), true);
    assert.deepEqual(state.calls, [
      ...(mode === 'minimized' ? ['restore'] : []),
      ...(mode === 'hidden' ? ['show'] : []),
      'focus',
      [DESKTOP_IPC.notificationOpenSession, 'exact-background-session'],
    ]);
  });
}

test('closing a banner does not open or focus a session', () => {
  const { window, state } = fakeWindow('hidden');
  const h = harness(null, { windows: { initial: window } });
  h.finish([{ id: 'a' }]);
  h.notifications[0].emit('close');
  assert.deepEqual(state.calls, []);
});

test('missing or destroyed windows reject notification navigation', () => {
  assert.equal(openDesktopNotificationSession(null, 'a'), false);
  assert.equal(openDesktopNotificationSession({ isDestroyed: () => true }, 'a'), false);
});

test('a click with no window rebuilds it and delivers the session once it exists', async (t) => {
  const h = harness(t, { windows: { initial: null } });
  h.finish([{ id: 'room-1', agentRoom: { name: 'Planning' } }]);
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
