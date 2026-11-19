import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// notification-window.ts reads Electron at import; outside Electron this stand-in answers (nothing here shows a toast).
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export default "";export const BrowserWindow = {};', shortCircuit: true }
      : next(specifier, context);
  },
});
const { registerNotificationHost, TEST_NOTIFICATION_BODY } = await import('./notification.ts');

function build(overrides = {}) {
  const handlers = new Map();
  const sent = [];
  const connection = {
    handleNotification: (method, handler) => handlers.set(method, handler),
    handleRequest: (method, handler) => handlers.set(method, handler),
    notify: (method, params) => sent.push([method, params]),
  };
  const calls = { toasts: [], activations: [], focused: [], steps: [], sounds: [] };
  const listeners = [];
  const closeAll = registerNotificationHost(connection, {
    createNotification: (content) => {
      const toast = {
        content,
        shown: 0,
        show() {
          this.shown += 1;
          if (overrides.showThrows) throw new Error('show failed');
        },
        close() { this.closed = (this.closed ?? 0) + 1; },
        on(event, fn) { listeners.push([toast, event, fn]); },
      };
      calls.toasts.push(toast);
      return toast;
    },
    playSound: async (volume) => { calls.sounds.push(volume); return 'played'; },
    activate: (thread) => calls.activations.push(thread),
    isSupported: () => true,
    idleSeconds: () => 0,
    diagnostic: (event, details) => calls.steps.push([event, details]),
    ...overrides,
  });
  const show = (params) => handlers.get('host/notification/show')(params);
  const fire = (toast, event, ...args) => listeners.filter(([t, e]) => t === toast && e === event).forEach(([, , fn]) => fn(...args));
  return { show, calls, sent, fire, closeAll };
}

test('a click on a local toast brings the window forward on the session it names and reports the click to the core', () => {
  const { show, calls, sent, fire } = build();
  show({ title: 'T', body: 'B', threadId: 'th9' });
  fire(calls.toasts[0], 'click');
  assert.deepEqual(calls.activations, ['th9']);
  assert.deepEqual(sent, [['host/notification/clicked', { threadId: 'th9' }]]);
  assert.deepEqual(calls.steps.map(([event]) => event), ['turn-notification-requested', 'turn-notification-clicked']);
  assert.deepEqual(calls.steps[1][1], { sessionId: 'th9' });
});

test('a click on a toast that names no session only brings the window forward', () => {
  const { show, calls, sent, fire } = build();
  show({ title: 'T', body: 'B' });
  fire(calls.toasts[0], 'click');
  assert.deepEqual(calls.activations, [undefined]);
  assert.deepEqual(sent, []);
});

test('a session the pet overlay shows has no toast and no sound; a server\'s toast is not the overlay\'s to hide', () => {
  const { show, calls } = build({ showsThread: (id) => id === 'pet' });
  show({ title: 'T', body: 'B', threadId: 'pet', sound: 'default' });
  assert.equal(calls.toasts.length, 0);
  assert.deepEqual(calls.sounds, []);
  assert.deepEqual(calls.steps, [['turn-notification-suppressed', { sessionId: 'pet', reason: 'foreground-visible' }]]);
  show({ title: 'T', body: 'B', threadId: 'other' });
  show({ title: 'T', body: 'B', threadId: 'pet', connectionId: 'ssh-1' });
  assert.equal(calls.toasts.length, 2);
});

test('the steps of a toast reach the diagnostics: requested, os-show, sound, closed, failed', async () => {
  const { show, calls, fire } = build();
  show({ title: 'T', body: 'B', threadId: 'a', sound: 'soft-rise', volume: 40 });
  fire(calls.toasts[0], 'show');
  fire(calls.toasts[0], 'failed', {}, 'denied');
  fire(calls.toasts[0], 'close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sounds, [40]);
  assert.deepEqual(
    calls.steps.map(([event]) => event).sort(),
    ['turn-notification-closed', 'turn-notification-failed', 'turn-notification-os-show', 'turn-notification-requested', 'turn-notification-sound'],
  );
  assert.deepEqual(calls.steps.find(([event]) => event === 'turn-notification-failed')[1], { sessionId: 'a', error: 'denied' });
});

test('a toast the OS cannot show is reported as suppressed, and one that cannot be built as failed', () => {
  const unsupported = build({ isSupported: () => false });
  unsupported.show({ title: 'T', body: 'B', threadId: 'a' });
  assert.equal(unsupported.calls.toasts.length, 0);
  assert.deepEqual(unsupported.calls.steps, [['turn-notification-suppressed', { sessionId: 'a', reason: 'unsupported' }]]);
  const broken = build({ createNotification: () => { throw new Error('no toast'); } });
  broken.show({ title: 'T', body: 'B', threadId: 'a' });
  assert.deepEqual(broken.calls.steps, [['turn-notification-failed', { sessionId: 'a', error: 'no toast' }]]);
});

test('the test notification is worded in this PC\'s language and an unsupported host shows nothing', () => {
  const words = build({ translate: (key) => `de:${key}` });
  words.show({ title: 'Mixdog', body: TEST_NOTIFICATION_BODY });
  assert.deepEqual(words.calls.toasts[0].content, { title: 'Mixdog', body: `de:${TEST_NOTIFICATION_BODY}` });
  const other = build({ translate: (key) => `de:${key}` });
  other.show({ title: 'T', body: 'Some other body' });
  assert.equal(other.calls.toasts[0].content.body, 'Some other body');
  const none = build({ translate: (key) => `de:${key}`, isSupported: () => false });
  none.show({ title: 'Mixdog', body: TEST_NOTIFICATION_BODY });
  assert.equal(none.calls.toasts.length, 0);
});

test('a toast whose show fails is reported and plays no sound; a failing sound leaves the click intact', async () => {
  const broken = build({ showThrows: true });
  broken.show({ title: 'T', body: 'B', threadId: 'a', sound: 'soft-rise' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(broken.calls.sounds, []);
  assert.deepEqual(broken.calls.steps.map(([event]) => event), ['turn-notification-requested', 'turn-notification-failed']);

  const mute = build({ playSound: async () => { throw new Error('no audio device'); } });
  mute.show({ title: 'T', body: 'B', threadId: 'a', sound: 'soft-rise' });
  mute.fire(mute.calls.toasts[0], 'show');
  await new Promise((resolve) => setImmediate(resolve));
  mute.fire(mute.calls.toasts[0], 'click');
  assert.deepEqual(mute.calls.activations, ['a']);
  assert.deepEqual(mute.sent, [['host/notification/clicked', { threadId: 'a' }]]);
  assert.deepEqual(mute.calls.steps.find(([event]) => event === 'turn-notification-sound-failed')[1], { sessionId: 'a', error: 'no audio device' });
});

test('closing a banner reports it and opens nothing; quitting closes the toasts still held', () => {
  const { show, calls, sent, fire, closeAll } = build();
  show({ title: 'T', body: 'B', threadId: 'a' });
  show({ title: 'T', body: 'B', threadId: 'b' });
  fire(calls.toasts[0], 'close');
  assert.deepEqual(calls.activations, []);
  assert.deepEqual(sent, []);
  closeAll();
  assert.equal(calls.toasts[1].closed, 1, 'the toast still showing is closed');
});

test('the sound plays when the OS shows the toast, once, not when show() returns', async () => {
  const { show, calls, fire } = build();
  show({ title: 'T', body: 'B', threadId: 'a', sound: 'soft-rise', volume: 40 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sounds, []);
  fire(calls.toasts[0], 'show');
  fire(calls.toasts[0], 'show');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sounds, [40]);
});
