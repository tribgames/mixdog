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

// The threshold timers are the whole contract of the overlay, so both are
// driven by hand instead of waiting out real seconds: `pendingDisconnect` is
// the 10s countdown and `pendingRecovery` the 3s connected hold.
async function withBanner(run) {
  clearRemoteConnectionState();
  const mount = document.querySelector('main');
  const root = createRoot(mount);
  const TIMER_ID = 987654;
  const RECOVERY_ID = 987655;
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const timers = { pendingDisconnect: null, pendingRecovery: null };
  window.setTimeout = (fn, ms) => {
    if (ms === 10_000) {
      timers.pendingDisconnect = fn;
      return TIMER_ID;
    }
    if (ms === 3_000) {
      timers.pendingRecovery = fn;
      return RECOVERY_ID;
    }
    return realSetTimeout(fn, ms);
  };
  window.clearTimeout = (id) => {
    if (id === TIMER_ID) {
      timers.pendingDisconnect = null;
      return;
    }
    if (id === RECOVERY_ID) {
      timers.pendingRecovery = null;
      return;
    }
    realClearTimeout(id);
  };
  const fire = async (name) => {
    const fn = timers[name];
    assert.ok(fn, `${name} is armed`);
    timers[name] = null;
    await act(async () => fn());
  };
  const setState = async (state) => {
    await act(async () => setRemoteConnectionState(state));
  };
  try {
    await act(async () => {
      root.render(React.createElement(RemoteConnectionBanner));
    });
    assert.equal(document.querySelector('.remote-connection-overlay'), null);
    await run({ timers, fire, setState });
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
}

const overlayElement = () => document.querySelector('.remote-connection-overlay');

test('a persistent disconnect shows diagnostics without resetting its countdown or retry behavior', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    // A short gap — every background return costs one — stays invisible.
    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('websocket');
    });
    assert.equal(overlayElement(), null);
    assert.ok(timers.pendingDisconnect);
    const countdown = timers.pendingDisconnect;
    await act(async () => {
      reportRemoteConnectionIssue('websocket-timeout');
    });
    assert.equal(timers.pendingDisconnect, countdown, 'diagnostic updates must not postpone the disconnect display');

    // A recovery that holds cancels the countdown instead of banking it.
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null);
    assert.equal(overlayElement(), null);

    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('encryption');
      reportRemoteConnectionIssue('encryption-timeout');
    });
    await fire('pendingDisconnect');
    const overlay = overlayElement();
    assert.ok(overlay);
    assert.equal(overlay.textContent, '', 'connection diagnostics never reach the screen');
    assert.equal(overlay.getAttribute('aria-label'), 'Retry');
    let retries = 0;
    const onRetry = () => retries++;
    window.addEventListener('mixdog:remote-wake', onRetry);
    await act(async () => overlay.click());
    window.removeEventListener('mixdog:remote-wake', onRetry);
    assert.equal(retries, 1);

    await setState('connected');
    assert.equal(overlayElement(), overlay, 'a fresh connection has not proven itself yet');
    await fire('pendingRecovery');
    assert.equal(overlayElement(), null);
    assert.equal(document.documentElement.dataset.mixdogRemotePhase, 'connected');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined);
  });
});

test('a flapping connection keeps the overlay up until a connection holds', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = overlayElement();
    assert.ok(overlay);
    for (let flap = 0; flap < 3; flap++) {
      await setState('connected');
      assert.ok(timers.pendingRecovery);
      assert.equal(overlayElement(), overlay, 'a connected blip must not hide the overlay');
      await setState('reconnecting');
      assert.equal(timers.pendingRecovery, null, 'leaving connected abandons the hold');
      assert.equal(overlayElement(), overlay, 'the overlay never cycles through hidden');
    }
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(overlayElement(), null);
  });
});

test('a connecting state after the overlay is shown keeps it up', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = overlayElement();
    assert.ok(overlay);
    await setState('connecting');
    assert.equal(overlayElement(), overlay);
    await setState('syncing');
    assert.equal(overlayElement(), overlay);
    await setState('connected');
    assert.equal(overlayElement(), overlay);
    await fire('pendingRecovery');
    assert.equal(overlayElement(), null);
  });
});

test('a connected blip before the overlay appears does not restart the countdown', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    const countdown = timers.pendingDisconnect;
    assert.ok(countdown);
    await setState('connected');
    assert.equal(timers.pendingDisconnect, countdown, 'an unproven connection keeps the countdown running');
    await setState('connecting');
    await setState('reconnecting');
    assert.equal(timers.pendingDisconnect, countdown, 'the countdown is never restarted mid-outage');
    await setState('syncing');
    assert.equal(timers.pendingDisconnect, countdown);
    await fire('pendingDisconnect');
    assert.ok(overlayElement());
  });
});

test('a countdown that expires during a connected blip surfaces only if the link drops again', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    assert.equal(overlayElement(), null, 'no overlay while the link is up');
    await setState('reconnecting');
    assert.ok(overlayElement());
  });
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    await fire('pendingRecovery');
    assert.equal(overlayElement(), null);
    await setState('reconnecting');
    assert.equal(overlayElement(), null, 'a held connection starts the countdown over');
    assert.ok(timers.pendingDisconnect);
  });
});

test('a hidden page neither counts toward nor keeps the disconnect overlay', async () => {
  const setVisibility = async (value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  };
  try {
    await withBanner(async ({ timers, fire, setState }) => {
      await setState('syncing');
      assert.ok(timers.pendingDisconnect);
      await setVisibility('hidden');
      assert.equal(timers.pendingDisconnect, null, 'going hidden cancels the countdown');
      await setState('connecting');
      await setState('reconnecting');
      assert.equal(timers.pendingDisconnect, null, 'no countdown runs while hidden');
      await setVisibility('visible');
      assert.equal(overlayElement(), null, 'a return from background never opens on the overlay');
      assert.ok(timers.pendingDisconnect, 'the return starts a fresh countdown');
      await fire('pendingDisconnect');
      assert.ok(overlayElement());
      await setVisibility('hidden');
      assert.equal(overlayElement(), null, 'going hidden drops a shown overlay');
    });
  } finally {
    delete document.visibilityState;
  }
});

test('a gap that recovers inside ten seconds shows nothing', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    const countdown = timers.pendingDisconnect;
    assert.ok(countdown);
    await setState('syncing');
    await setState('connected');
    assert.equal(overlayElement(), null);
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null, 'a held connection cancels the countdown');
    assert.equal(overlayElement(), null);
    await setState('reconnecting');
    assert.ok(timers.pendingDisconnect);
    assert.notEqual(timers.pendingDisconnect, countdown, 'the next gap starts a fresh countdown');
    assert.equal(overlayElement(), null);
  });
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

test('a resumed sync that resends no transcript still ends and reports its wait', () => {
  clearRemoteConnectionState();
  beginRemoteConnectionTimeline('wake');
  setRemoteConnectionPhase('sync');
  assert.match(takeRemoteConnectionTimeline('resumed'), /^cause=wake phase=sync@\d+ resumed@\d+$/u);
  assert.equal(takeRemoteConnectionTimeline(), '', 'a transcript frame after it reports nothing more');
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
