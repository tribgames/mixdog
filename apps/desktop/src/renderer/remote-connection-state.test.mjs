import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['Event', 'navigator'],
});

const {
  beginRemoteConnectionTimeline,
  clearRemoteConnectionState,
  currentRemoteConnectionState,
  REMOTE_DESKTOP_OFFLINE_CLOSE,
  takeRemoteConnectionTimeline,
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
  subscribeRemoteConnectionState,
} = await import('./remote-connection-state.ts');
const { RemoteConnectionBanner } = await import('./RemoteConnectionBanner.tsx');
const { isInvalidRemotePairingClose } = await import('./remote-pairing-recovery.ts');

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
async function withBanner(run, props = {}) {
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
      root.render(React.createElement(RemoteConnectionBanner, props));
    });
    assert.equal(document.querySelector('.remote-connection-indicator'), null);
    await run({ timers, fire, setState });
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
}

const indicatorElement = () => document.querySelector('.remote-connection-indicator');

test('a persistent disconnect shows diagnostics without resetting its countdown or retry behavior', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    // A short gap — every background return costs one — stays invisible.
    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('websocket');
    });
    assert.equal(indicatorElement(), null);
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
    assert.equal(indicatorElement(), null);

    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('encryption');
      reportRemoteConnectionIssue('encryption-timeout');
    });
    await fire('pendingDisconnect');
    const overlay = indicatorElement();
    assert.ok(overlay);
    // A bare dot: no words, no cause, no error, nothing to act on.
    assert.equal(overlay.textContent, '');
    assert.equal(overlay.getAttribute('aria-label'), 'Connecting…');
    let retries = 0;
    const onRetry = () => retries++;
    window.addEventListener('mixdog:remote-wake', onRetry);
    await act(async () => overlay.click());
    window.removeEventListener('mixdog:remote-wake', onRetry);
    assert.equal(retries, 1);

    await setState('connected');
    assert.equal(indicatorElement(), overlay, 'a fresh connection has not proven itself yet');
    await fire('pendingRecovery');
    assert.equal(indicatorElement(), null);
    assert.equal(document.documentElement.dataset.mixdogRemotePhase, 'connected');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined);
  });
});

test('a flapping connection keeps the overlay up until a connection holds', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = indicatorElement();
    assert.ok(overlay);
    for (let flap = 0; flap < 3; flap++) {
      await setState('connected');
      assert.ok(timers.pendingRecovery);
      assert.equal(indicatorElement(), overlay, 'a connected blip must not hide the overlay');
      await setState('reconnecting');
      assert.equal(timers.pendingRecovery, null, 'leaving connected abandons the hold');
      assert.equal(indicatorElement(), overlay, 'the overlay never cycles through hidden');
    }
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(indicatorElement(), null);
  });
});

test('a connecting state after the overlay is shown keeps it up', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = indicatorElement();
    assert.ok(overlay);
    await setState('connecting');
    assert.equal(indicatorElement(), overlay);
    await setState('syncing');
    assert.equal(indicatorElement(), overlay);
    await setState('connected');
    assert.equal(indicatorElement(), overlay);
    await fire('pendingRecovery');
    assert.equal(indicatorElement(), null);
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
    await fire('pendingDisconnect');
    assert.ok(indicatorElement());
  });
});

// A redial that lands straight in a healthy view sync, with no 'connected'
// in between: the link is up, so the countdown it started counts no further.
test('a redial that goes straight into a healthy sync never shows the dot', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('connecting');
    assert.ok(timers.pendingDisconnect);
    await setState('syncing');
    assert.ok(timers.pendingRecovery, 'a healthy sync holds toward recovery');
    await fire('pendingDisconnect');
    assert.equal(indicatorElement(), null, 'an expired countdown shows nothing while the link is up');
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null);
    await setState('connected');
    assert.equal(indicatorElement(), null);
  });
  // A countdown that expired during a short healthy sync surfaces only if
  // the link really drops again.
  await withBanner(async ({ fire, setState }) => {
    await setState('connecting');
    await setState('syncing');
    await fire('pendingDisconnect');
    assert.equal(indicatorElement(), null);
    await setState('reconnecting');
    assert.ok(indicatorElement());
  });
});

test('a countdown that expires during a connected blip surfaces only if the link drops again', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    assert.equal(indicatorElement(), null, 'no overlay while the link is up');
    await setState('reconnecting');
    assert.ok(indicatorElement());
  });
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    await fire('pendingRecovery');
    assert.equal(indicatorElement(), null);
    await setState('reconnecting');
    assert.equal(indicatorElement(), null, 'a held connection starts the countdown over');
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
      await setState('reconnecting');
      assert.ok(timers.pendingDisconnect);
      await setVisibility('hidden');
      assert.equal(timers.pendingDisconnect, null, 'going hidden cancels the countdown');
      await setState('connecting');
      await setState('reconnecting');
      assert.equal(timers.pendingDisconnect, null, 'no countdown runs while hidden');
      await setVisibility('visible');
      assert.equal(indicatorElement(), null, 'a return from background never opens on the overlay');
      assert.ok(timers.pendingDisconnect, 'the return starts a fresh countdown');
      await fire('pendingDisconnect');
      assert.ok(indicatorElement());
      await setVisibility('hidden');
      assert.equal(indicatorElement(), null, 'going hidden drops a shown overlay');
    });
  } finally {
    delete document.visibilityState;
  }
});

test('a redial counts toward the calm indicator; a sync on a live socket does not', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    // A resume redial or a re-handshake on a kept socket: the link is down,
    // so a long one earns the pill — but nothing before the threshold.
    await setState('connecting');
    assert.ok(timers.pendingDisconnect);
    assert.equal(indicatorElement(), null);
    await setState('connected');
    await fire('pendingRecovery');
    // The socket is up and the PC is sending the view: however long a busy
    // PC takes, the transcript on screen stays readable.
    await setState('syncing');
    assert.equal(timers.pendingDisconnect, null);
    // A sync that FAILED is a failed attempt: its retries start the countdown.
    await act(async () => reportRemoteConnectionIssue('sync-failed'));
    assert.ok(timers.pendingDisconnect);
    await fire('pendingDisconnect');
    assert.equal(indicatorElement()?.getAttribute('aria-label'), 'Connecting…');
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(indicatorElement(), null);
    // The failure belonged to that sync, not to the next one.
    await setState('syncing');
    assert.equal(timers.pendingDisconnect, null);
  });
});

test('a cold boot has nothing on screen, so every wait counts there', async () => {
  await withBanner(
    async ({ timers, fire, setState }) => {
      await setState('connecting');
      assert.ok(timers.pendingDisconnect);
      await setState('syncing');
      await fire('pendingDisconnect');
      assert.ok(indicatorElement());
    },
    { boot: true }
  );
});

test('a cold boot that connects quickly never shows the indicator', async () => {
  await withBanner(
    async ({ timers, fire, setState }) => {
      await setState('connecting');
      await setState('syncing');
      await setState('connected');
      assert.equal(indicatorElement(), null);
      await fire('pendingRecovery');
      assert.equal(timers.pendingDisconnect, null);
      assert.equal(indicatorElement(), null);
    },
    { boot: true }
  );
});

test('a gap that recovers inside ten seconds shows nothing', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    const countdown = timers.pendingDisconnect;
    assert.ok(countdown);
    await setState('syncing');
    await setState('connected');
    assert.equal(indicatorElement(), null);
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null, 'a held connection cancels the countdown');
    assert.equal(indicatorElement(), null);
    await setState('reconnecting');
    assert.ok(timers.pendingDisconnect);
    assert.notEqual(timers.pendingDisconnect, countdown, 'the next gap starts a fresh countdown');
    assert.equal(indicatorElement(), null);
  });
});

test('the indicator never turns a cause into an error and never blocks the screen', async () => {
  const setOnline = async (online) => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    await act(async () => window.dispatchEvent(new window.Event(online ? 'online' : 'offline')));
  };
  try {
    await withBanner(async ({ fire, setState }) => {
      await setState('reconnecting');
      await fire('pendingDisconnect');
      const indicator = indicatorElement();
      // A dot, not a layer over the screen.
      assert.notEqual(indicator.className, 'remote-connection-overlay');
      assert.equal(indicator.querySelector('svg'), null);
      // The PC being offline, this device's own network, a failed attempt:
      // the shim retries each on its own, and the pill says only that.
      await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
      assert.equal(indicatorElement().getAttribute('aria-label'), 'Connecting…');
      await setOnline(false);
      assert.equal(indicatorElement().getAttribute('aria-label'), 'Connecting…');
      await setOnline(true);
      await act(async () => reportRemoteConnectionIssue('encryption-timeout'));
      assert.equal(indicatorElement().getAttribute('aria-label'), 'Connecting…');
      await act(async () => setRemoteConnectionPhase('sync'));
      await setState('syncing');
      assert.equal(indicatorElement().getAttribute('aria-label'), 'Connecting…');
      await setState('connected');
      await fire('pendingRecovery');
      assert.equal(indicatorElement(), null);
    });
  } finally {
    delete window.navigator.onLine;
  }
});

test('the PC-offline close is transient and keeps the stored pairing', () => {
  assert.equal(isInvalidRemotePairingClose({ code: REMOTE_DESKTOP_OFFLINE_CLOSE, reason: 'desktop offline' }), false);
  assert.equal(isInvalidRemotePairingClose({ code: 4005, reason: '' }), true);
});

test('only real authentication failures drop the pairing; a redial race never does', () => {
  const close = (reason) => isInvalidRemotePairingClose({ code: 4004, reason });
  assert.equal(close('relay encryption authentication failed'), true);
  assert.equal(close('invalid encrypted relay frame'), true);
  assert.equal(close('relay encryption handshake required'), false);
  assert.equal(close('relay encryption handshake timed out'), false);
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
