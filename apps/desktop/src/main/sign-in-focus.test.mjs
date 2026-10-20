import assert from 'node:assert/strict';
import test from 'node:test';

import { raiseDesktopWindow } from './notification-window.ts';
import { createSignInFocus } from './sign-in-focus.ts';

function tracker() {
  let raised = 0;
  const focus = createSignInFocus({ activate: () => raised++ });
  return { focus, raised: () => raised };
}
const begin = (focus, flowId, options) =>
  focus.observe('beginMcpOAuthLogin', options ? ['notion', options] : ['notion'], {
    flowId,
    state: 'pending',
    step: 'browser',
    url: 'https://x/authorize',
  });
const status = (focus, flowId, value) => focus.observe('getMcpOAuthLoginStatus', [flowId, {}], { flowId, ...value });

test('a sign-in this window started raises it once, when the browser callback arrives', () => {
  const { focus, raised } = tracker();
  begin(focus, 'f1');
  status(focus, 'f1', { state: 'pending', step: 'browser' });
  assert.equal(raised(), 0, 'still in the browser');
  status(focus, 'f1', { state: 'pending', step: 'connecting' });
  assert.equal(raised(), 1);
  status(focus, 'f1', { state: 'pending', step: 'tools' });
  status(focus, 'f1', { state: 'complete' });
  assert.equal(raised(), 1, 'at most once per sign-in');
  // A fast flow seen first as complete still comes back.
  begin(focus, 'f2');
  status(focus, 'f2', { state: 'complete' });
  assert.equal(raised(), 2);
  // A denial in the browser also brings the user back to read why.
  begin(focus, 'f3');
  status(focus, 'f3', { state: 'failed', error: 'denied' });
  assert.equal(raised(), 3);
});

test('focus is never taken for anything else', () => {
  const { focus, raised } = tracker();
  // Not begun from this window (another window, the phone, a chat card elsewhere).
  status(focus, 'other', { state: 'pending', step: 'connecting' });
  // A sign-in whose browser is on another device.
  begin(focus, 'remote', { openBrowser: false });
  status(focus, 'remote', { state: 'complete' });
  // Cancelled in the app, then a late status.
  begin(focus, 'cancelled');
  focus.observe('cancelMcpOAuthLogin', ['cancelled'], { flowId: 'cancelled', state: 'cancelled' });
  status(focus, 'cancelled', { state: 'pending', step: 'connecting' });
  // Settled without the user: cancelled elsewhere or timed out.
  begin(focus, 'gone');
  status(focus, 'gone', { state: 'cancelled' });
  begin(focus, 'late');
  status(focus, 'late', { state: 'failed', reason: 'timeout' });
  // Stored credentials sufficed: no browser, nothing to come back from.
  focus.observe('beginMcpOAuthLogin', ['notion'], { flowId: 'quiet', state: 'complete' });
  status(focus, 'quiet', { state: 'complete' });
  // Other capabilities with a flow-looking first argument.
  begin(focus, 'f9');
  focus.observe('mcpStatus', ['f9'], { state: 'complete' });
  assert.equal(raised(), 0);
});

test('a forgotten sign-in expires', () => {
  let now = 0;
  let raised = 0;
  const focus = createSignInFocus({ activate: () => raised++, now: () => now });
  begin(focus, 'old');
  now = 7 * 60_000;
  status(focus, 'old', { state: 'complete' });
  assert.equal(raised, 0);
});

function fakeWindow({ focusSticks, minimized = false }) {
  const calls = [];
  let focused = false;
  const listeners = {};
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => {
      calls.push('restore');
      minimized = false;
    },
    isVisible: () => true,
    show: () => calls.push('show'),
    focus: () => {
      calls.push('focus');
      if (focusSticks) focused = true;
    },
    isFocused: () => focused,
    setAlwaysOnTop: (flag) => calls.push(`top:${flag}`),
    moveTop: () => calls.push('moveTop'),
    flashFrame: (flag) => calls.push(`flash:${flag}`),
    once: (event, listener) => {
      listeners[event] = listener;
    },
    emit: (event) => listeners[event]?.(),
  };
}

test('raising restores and focuses; on Windows a refused focus still raises the window and flashes it', () => {
  const ok = fakeWindow({ focusSticks: true, minimized: true });
  assert.equal(raiseDesktopWindow(ok, 'win32'), true);
  assert.deepEqual(ok.calls, ['restore', 'focus']);

  const locked = fakeWindow({ focusSticks: false });
  raiseDesktopWindow(locked, 'win32');
  assert.deepEqual(locked.calls, ['focus', 'top:true', 'moveTop', 'top:false', 'focus', 'flash:true']);
  locked.emit('focus');
  assert.equal(locked.calls.at(-1), 'flash:false', 'the flash stops once the user focuses it');

  const mac = fakeWindow({ focusSticks: false });
  raiseDesktopWindow(mac, 'darwin');
  assert.deepEqual(mac.calls, ['focus']);
  assert.equal(raiseDesktopWindow(null, 'win32'), false);
});
