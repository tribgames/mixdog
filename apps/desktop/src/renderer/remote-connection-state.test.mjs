import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  beginRemoteConnectionTimeline,
  clearRemoteConnectionState,
  currentRemoteConnectionState,
  takeRemoteConnectionTimeline,
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
  subscribeRemoteConnectionState,
} = await import('./remote-connection-state.ts');
const { RemoteConnectionBanner } = await import('./RemoteConnectionBanner.tsx');

test('the mobile heartbeat runs only while the page is foregrounded', () => {
  assert.equal(shouldRunRemoteHeartbeat('visible'), true);
  assert.equal(shouldRunRemoteHeartbeat('hidden'), false);
  assert.equal(shouldRunRemoteHeartbeat('prerender'), false);
});

test('remote connection state publishes every lifecycle transition', () => {
  const states = [];
  const unsubscribe = subscribeRemoteConnectionState(() => {
    states.push(currentRemoteConnectionState());
  });
  try {
    setRemoteConnectionState('connecting');
    setRemoteConnectionState('connected');
    setRemoteConnectionState('reconnecting');
    clearRemoteConnectionState();
  } finally {
    unsubscribe();
  }
  assert.deepEqual(states, ['connecting', 'connected', 'reconnecting', null]);
});

test('a transient disconnect carries no user-facing wording', () => {
  const error = remoteConnectionInterruptedError();
  assert.equal(error.name, 'RemoteConnectionInterruptedError');
  assert.equal(error.code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
  assert.equal(error.message, '');
});

test('a persistent disconnect shows diagnostics without resetting its countdown or retry behavior', async () => {
  clearRemoteConnectionState();
  const mount = document.querySelector('main');
  const root = createRoot(mount);
  // The threshold timer is the whole contract here, so it is driven by hand
  // instead of waiting out ten real seconds.
  const TIMER_ID = 987654;
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  let pendingDisconnect = null;
  window.setTimeout = (fn, ms) => {
    if (ms === 10_000) {
      pendingDisconnect = fn;
      return TIMER_ID;
    }
    return realSetTimeout(fn, ms);
  };
  window.clearTimeout = (id) => {
    if (id === TIMER_ID) {
      pendingDisconnect = null;
      return;
    }
    realClearTimeout(id);
  };
  try {
    await act(async () => {
      root.render(React.createElement(RemoteConnectionBanner));
    });
    assert.equal(document.querySelector('.remote-connection-overlay'), null);

    // A short gap — every background return costs one — stays invisible.
    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('websocket');
    });
    assert.equal(document.querySelector('.remote-connection-overlay'), null);
    assert.ok(pendingDisconnect);
    const countdown = pendingDisconnect;
    await act(async () => {
      reportRemoteConnectionIssue('websocket-timeout');
    });
    assert.equal(pendingDisconnect, countdown, 'diagnostic updates must not postpone the disconnect display');

    // Recovering inside the window cancels the countdown instead of banking it.
    await act(async () => {
      setRemoteConnectionState('connected');
    });
    assert.equal(pendingDisconnect, null);
    assert.equal(document.querySelector('.remote-connection-overlay'), null);

    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('encryption');
      reportRemoteConnectionIssue('encryption-timeout');
    });
    await act(async () => {
      pendingDisconnect?.();
    });
    const overlay = document.querySelector('.remote-connection-overlay');
    assert.ok(overlay);
    assert.equal(overlay.textContent, '', 'connection diagnostics never reach the screen');
    assert.equal(overlay.getAttribute('aria-label'), 'Retry');
    let retries = 0;
    const onRetry = () => retries++;
    window.addEventListener('mixdog:remote-wake', onRetry);
    await act(async () => overlay.click());
    window.removeEventListener('mixdog:remote-wake', onRetry);
    assert.equal(retries, 1);

    await act(async () => {
      setRemoteConnectionState('connected');
    });
    assert.equal(document.querySelector('.remote-connection-overlay'), null);
    assert.equal(document.documentElement.dataset.mixdogRemotePhase, 'connected');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined);
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
});

test('a connection timeline reports each wait once, in order, with fixed tokens only', () => {
  clearRemoteConnectionState();
  assert.equal(takeRemoteConnectionTimeline(), '');
  beginRemoteConnectionTimeline('wake');
  setRemoteConnectionPhase('websocket');
  reportRemoteConnectionIssue('websocket-closed', new Error('private transcript text'), 1006);
  setRemoteConnectionState('reconnecting');
  setRemoteConnectionPhase('sync');
  const text = takeRemoteConnectionTimeline();
  assert.match(
    text,
    /^cause=wake phase=websocket@\d+ issue=websocket-closed:1006@\d+ state=reconnecting@\d+ phase=sync@\d+ transcript@\d+$/u
  );
  assert.doesNotMatch(text, /private/u);
  assert.equal(takeRemoteConnectionTimeline(), '', 'a finished wait is reported once');
  clearRemoteConnectionState();
});

test('diagnostics retain the failing phase across retries and never record arbitrary error data', () => {
  clearRemoteConnectionState();
  const data = document.documentElement.dataset;
  try {
    setRemoteConnectionPhase('registration');
    reportRemoteConnectionIssue('registration-failed', new Error('https://relay.test/?token=private-key'), 403);
    setRemoteConnectionPhase('websocket');
    assert.equal(data.mixdogRemotePhase, 'websocket');
    assert.equal(data.mixdogRemoteError, 'registration / registration-failed / code=403 / Error');
    setRemoteConnectionPhase('sync');
    reportRemoteConnectionIssue('sync-failed', { name: 'private-key', message: 'private transcript text' });
    assert.equal(data.mixdogRemoteError, 'sync / sync-failed / Error');
    reportRemoteConnectionIssue('frame-failed', new Error('View baseline is no longer available.'));
    assert.equal(data.mixdogRemoteError, 'sync / frame-failed / View baseline is no longer available.');
  } finally {
    clearRemoteConnectionState();
  }
  assert.equal(data.mixdogRemotePhase, undefined);
  assert.equal(data.mixdogRemoteError, undefined);
});
