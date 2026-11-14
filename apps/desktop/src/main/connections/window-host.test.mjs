import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerNotificationHost } from '../host/notification.ts';
import { createWindowHost, registerWindowHost } from './window-host.ts';

function build(overrides = {}) {
  const calls = { open: [], close: [], focus: [], report: [] };
  let release;
  const deps = {
    open: (p) => {
      calls.open.push(p);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    close: (id) => calls.close.push(id),
    focus: (id, sessionId) => calls.focus.push([id, sessionId]),
    report: (method, params) => calls.report.push([method, params]),
    debounceMs: 10,
    ...overrides,
  };
  return { host: createWindowHost(deps), calls, release: (v) => release(v) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = { connectionId: 'c1', kind: 'ssh', name: 'box' };

test('an open for a window still being created joins it: one creation, one answer', async () => {
  const { host, calls, release } = build();
  const first = host.handlers['host/window/open'](open);
  const second = host.handlers['host/window/open'](open);
  assert.equal(calls.open.length, 1);
  release(true);
  assert.deepEqual(await first, { opened: true });
  assert.deepEqual(await second, { opened: true });
  const third = host.handlers['host/window/open'](open);
  assert.equal(calls.open.length, 2);
  release(false);
  assert.deepEqual(await third, { opened: false });
});

test('a window that cannot be made answers opened false; bad params are invalid params', async () => {
  const { host } = build({ open: async () => { throw new Error('boom'); } });
  assert.deepEqual(await host.handlers['host/window/open'](open), { opened: false });
  await assert.rejects(host.handlers['host/window/open']({ connectionId: 'c', kind: 'x', name: 'n' }), { code: -32602 });
  await assert.rejects(host.handlers['host/window/close']({}), { code: -32602 });
});

test('close and focus reach the window layer; focus carries the session', async () => {
  const { host, calls } = build();
  assert.deepEqual(await host.handlers['host/window/close']({ connectionId: 'c1' }), {});
  await host.handlers['host/window/focus']({ connectionId: 'local', sessionId: 's1' });
  await host.handlers['host/window/focus']({ connectionId: 'c1' });
  assert.deepEqual(calls.close, ['c1']);
  assert.deepEqual(calls.focus, [['local', 's1'], ['c1', undefined]]);
});

test('closed is reported only for a window the core opened, byUser for a user close and false for a quit', async () => {
  const { host, calls } = build({ open: async () => true });
  // A core that never asked for a window (one without the connections service) is never told one closed.
  host.windowClosed('c1', true);
  assert.deepEqual(calls.report, []);
  await host.handlers['host/window/open']({ connectionId: 'c1', kind: 'ssh', name: 'a' });
  await host.handlers['host/window/open']({ connectionId: 'c2', kind: 'ssh', name: 'b' });
  host.windowClosed('c1', true);
  host.windowClosed('c2', false);
  // Once: a second close of the same window is not a second report.
  host.windowClosed('c1', true);
  assert.deepEqual(calls.report, [
    ['host/window/closed', { connectionId: 'c1', byUser: true }],
    ['host/window/closed', { connectionId: 'c2', byUser: false }],
  ]);
});

test('a window the core could not open, or opened on a closed connection, is not reported closed', async () => {
  const { host, calls } = build({ open: async () => false });
  await host.handlers['host/window/open'](open);
  host.windowClosed('c1', true);
  const reopened = build({ open: async () => true });
  await reopened.host.handlers['host/window/open'](open);
  reopened.host.dispose();
  reopened.host.windowClosed('c1', true);
  assert.deepEqual([...calls.report, ...reopened.calls.report], []);
});

test('a burst of focus changes is one windowFocus report, and an unchanged state is not re-sent', async () => {
  const { host, calls } = build();
  const win = (focused) => [{ connectionId: 'local', visible: true, focused }];
  host.publishFocus(win(false));
  host.publishFocus(win(true));
  host.publishFocus(win(false));
  assert.equal(calls.report.length, 0);
  await wait(40);
  assert.deepEqual(calls.report, [['host/state/set', { key: 'windowFocus', value: { windows: win(false) } }]]);
  host.publishFocus(win(false));
  await wait(40);
  assert.equal(calls.report.length, 1);
  host.publishFocus(win(true));
  await wait(40);
  assert.equal(calls.report.length, 2);
});

test('registerWindowHost serves the three requests and forgets what was reported when the connection closes', async () => {
  const served = new Map();
  const closers = [];
  const connection = { handleRequest: (m, h) => served.set(m, h), onClose: (l) => closers.push(l) };
  const calls = [];
  const host = registerWindowHost(connection, { open: async () => true, close() {}, focus() {}, report: (m, p) => calls.push([m, p]), debounceMs: 5 });
  assert.deepEqual([...served.keys()].sort(), ['host/window/close', 'host/window/focus', 'host/window/open']);
  const windows = [{ connectionId: 'local', visible: true, focused: true }];
  host.publishFocus(windows);
  await wait(30);
  closers.forEach((l) => l());
  host.publishFocus(windows);
  await wait(30);
  assert.equal(calls.length, 2);
});

test('a click on a server notification focuses that server window and reports the connection', () => {
  const notifications = new Map();
  const connection = { handleRequest() {}, handleNotification: (m, h) => notifications.set(m, h), notify: (m, p) => sent.push([m, p]) };
  const sent = [];
  const clicks = [];
  const focused = [];
  let activations = 0;
  registerNotificationHost(connection, {
    createNotification: () => ({ on: (_e, fn) => clicks.push(fn), show() {} }),
    activate: () => { activations += 1; },
    focusConnection: (id, thread) => focused.push([id, thread]),
    isSupported: () => true,
    idleSeconds: () => 0,
  });
  notifications.get('host/notification/show')({ title: 'T', body: 'B', threadId: 'th1', connectionId: 'c1' });
  notifications.get('host/notification/show')({ title: 'T', body: 'B', threadId: 'th2' });
  clicks.forEach((fn) => fn());
  assert.deepEqual(focused, [['c1', 'th1']]);
  assert.equal(activations, 1);
  assert.deepEqual(sent, [
    ['host/notification/clicked', { threadId: 'th1', connectionId: 'c1' }],
    ['host/notification/clicked', { threadId: 'th2' }],
  ]);
});
