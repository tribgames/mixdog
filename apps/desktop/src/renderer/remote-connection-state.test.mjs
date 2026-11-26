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
const { RemoteConnectionBanner, useRemoteConnectionLine, useRemoteSendBlocked } = await import(
  './RemoteConnectionBanner.tsx'
);
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

// The threshold timers are the whole contract of the outage clock, so they
// are driven by hand instead of waiting out real seconds: `pendingDisconnect`
// is the 10s countdown, `pendingRecovery` the 3s connected hold and
// `pendingFailure` the 30s connecting wait before transitioning to failed.
async function withBanner(run) {
  clearRemoteConnectionState();
  const mount = document.querySelector('main');
  const root = createRoot(mount);
  const ids = { pendingDisconnect: 987654, pendingRecovery: 987655, pendingFailure: 987656 };
  const byDelay = { 10000: 'pendingDisconnect', 3000: 'pendingRecovery', 30000: 'pendingFailure' };
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const timers = { pendingDisconnect: null, pendingRecovery: null, pendingFailure: null };
  let latestPhase = 'hidden';
  let latestBlocked = false;
  function Probe() {
    latestPhase = useRemoteConnectionLine().phase;
    latestBlocked = useRemoteSendBlocked();
    return null;
  }
  window.setTimeout = (fn, ms) => {
    const name = byDelay[ms];
    if (!name) return realSetTimeout(fn, ms);
    timers[name] = fn;
    return ids[name];
  };
  window.clearTimeout = (id) => {
    const name = Object.keys(ids).find((key) => ids[key] === id);
    if (name) timers[name] = null;
    else realClearTimeout(id);
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
  const phaseOf = () => latestPhase;
  const sendBlocked = () => latestBlocked;
  try {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RemoteConnectionBanner),
          React.createElement(Probe)
        )
      );
    });
    assert.equal(document.querySelector('.composer-connection-line'), null);
    assert.equal(document.querySelector('.remote-boot-line'), null);
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
    await run({ timers, fire, setState, phaseOf, sendBlocked });
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
}

test('a persistent disconnect tracks diagnostics without resetting its countdown and renders no connection card', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    // A short gap — every background return costs one — stays hidden.
    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('websocket');
    });
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
    assert.ok(timers.pendingDisconnect);
    const countdown = timers.pendingDisconnect;
    await act(async () => {
      reportRemoteConnectionIssue('websocket-timeout');
    });
    assert.equal(timers.pendingDisconnect, countdown, 'diagnostic updates must not postpone the disconnect outage');

    // A recovery that holds cancels the countdown instead of banking it.
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null);
    assert.equal(phaseOf(), 'hidden');

    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('encryption');
      reportRemoteConnectionIssue('encryption-timeout');
    });
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    assert.equal(sendBlocked(), true);
    assert.equal(document.querySelector('.composer-connection-line'), null, 'no connection card renders');
    assert.equal(document.querySelector('.remote-boot-line'), null, 'no boot connection card renders');

    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
    await fire('pendingRecovery');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(document.documentElement.dataset.mixdogRemotePhase, 'connected');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined);
  });
});

test('a flapping connection keeps the outage active until a connection holds', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    assert.equal(sendBlocked(), true);
    for (let flap = 0; flap < 3; flap++) {
      await setState('connected');
      assert.ok(timers.pendingRecovery);
      assert.equal(phaseOf(), 'hidden');
      assert.equal(sendBlocked(), false);
      await setState('reconnecting');
      assert.equal(timers.pendingRecovery, null, 'leaving connected abandons the hold');
      assert.equal(phaseOf(), 'connecting', 'flapping back re-enters outage without waiting another 10s');
      assert.equal(sendBlocked(), true);
    }
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
  });
});

test('a connecting state after the outage starts keeps it active', async () => {
  await withBanner(async ({ fire, setState, phaseOf }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    await setState('connecting');
    assert.equal(phaseOf(), 'connecting');
    await setState('syncing');
    assert.equal(phaseOf(), 'hidden');
    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
    await fire('pendingRecovery');
    assert.equal(phaseOf(), 'hidden');
  });
});

test('a connected blip before the outage surfaces does not restart the countdown', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf }) => {
    await setState('reconnecting');
    const countdown = timers.pendingDisconnect;
    assert.ok(countdown);
    await setState('connected');
    assert.equal(timers.pendingDisconnect, countdown, 'an unproven connection keeps the countdown running');
    await setState('connecting');
    await setState('reconnecting');
    assert.equal(timers.pendingDisconnect, countdown, 'the countdown is never restarted mid-outage');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
  });
});

// A redial that lands straight in a healthy view sync, with no 'connected'
// in between: the link is up, so the countdown it started counts no further.
test('a redial that goes straight into a healthy sync never blocks sends', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf }) => {
    await setState('connecting');
    assert.ok(timers.pendingDisconnect);
    await setState('syncing');
    assert.ok(timers.pendingRecovery, 'a healthy sync holds toward recovery');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'hidden', 'an expired countdown stays hidden while the link is up');
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null);
    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
  });
  // A countdown that expired during a short healthy sync surfaces only if
  // the link really drops again.
  await withBanner(async ({ fire, setState, phaseOf }) => {
    await setState('connecting');
    await setState('syncing');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'hidden');
    await setState('reconnecting');
    assert.equal(phaseOf(), 'connecting');
  });
});

test('a countdown that expires during a connected blip surfaces only if the link drops again', async () => {
  await withBanner(async ({ fire, setState, phaseOf }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'hidden', 'no outage while the link is up');
    await setState('reconnecting');
    assert.equal(phaseOf(), 'connecting');
  });
  await withBanner(async ({ timers, fire, setState, phaseOf }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    await fire('pendingRecovery');
    assert.equal(phaseOf(), 'hidden');
    await setState('reconnecting');
    assert.equal(phaseOf(), 'hidden', 'a held connection starts the countdown over');
    assert.ok(timers.pendingDisconnect);
  });
});

test('a hidden page neither counts toward nor keeps the outage', async () => {
  const setVisibility = async (value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  };
  try {
    await withBanner(async ({ timers, fire, setState, phaseOf }) => {
      await setState('reconnecting');
      assert.ok(timers.pendingDisconnect);
      await setVisibility('hidden');
      assert.equal(timers.pendingDisconnect, null, 'going hidden cancels the countdown');
      await setState('connecting');
      await setState('reconnecting');
      assert.equal(timers.pendingDisconnect, null, 'no countdown runs while hidden');
      await setVisibility('visible');
      assert.equal(phaseOf(), 'hidden', 'a return from background never opens in an outage');
      assert.ok(timers.pendingDisconnect, 'the return starts a fresh countdown');
      await fire('pendingDisconnect');
      assert.equal(phaseOf(), 'connecting');
      await setVisibility('hidden');
      assert.equal(phaseOf(), 'hidden', 'going hidden drops an active outage');
    });
  } finally {
    delete document.visibilityState;
  }
});

test('a redial counts toward the outage; a sync on a live socket does not', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf }) => {
    // A resume redial or a re-handshake on a kept socket: the link is down,
    // so a long one starts the outage — but nothing before the threshold.
    await setState('connecting');
    assert.ok(timers.pendingDisconnect);
    assert.equal(phaseOf(), 'hidden');
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
    assert.equal(phaseOf(), 'connecting');
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(phaseOf(), 'hidden');
    // The failure belonged to that sync, not to the next one.
    await setState('syncing');
    assert.equal(timers.pendingDisconnect, null);
  });
});

test('a live session never turns the PC-offline answer into an immediate outage', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    await setState('reconnecting');
    await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
    assert.equal(phaseOf(), 'hidden', 'the calm countdown still runs');
    assert.equal(sendBlocked(), false);
    assert.ok(timers.pendingDisconnect);
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'failed');
    assert.equal(sendBlocked(), true);
    assert.equal(document.querySelector('.composer-connection-line'), null);
    assert.equal(document.querySelector('.remote-boot-line'), null);
  });
});

test('a link still down after connecting for a while transitions to failed', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    assert.equal(sendBlocked(), true);
    assert.ok(timers.pendingFailure);
    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
    assert.equal(timers.pendingFailure, null, 'a connection cancels a pending failure timer');
  });
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    assert.equal(sendBlocked(), true);
    assert.ok(timers.pendingFailure);
    await fire('pendingFailure');
    assert.equal(phaseOf(), 'failed');
    assert.equal(sendBlocked(), true);
    assert.equal(document.querySelector('.composer-connection-line'), null);
    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
  });
});

test('a gap that recovers inside ten seconds never blocks sends', async () => {
  await withBanner(async ({ timers, fire, setState, phaseOf, sendBlocked }) => {
    await setState('reconnecting');
    const countdown = timers.pendingDisconnect;
    assert.ok(countdown);
    await setState('syncing');
    await setState('connected');
    assert.equal(phaseOf(), 'hidden');
    assert.equal(sendBlocked(), false);
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null, 'a held connection cancels the countdown');
    assert.equal(phaseOf(), 'hidden');
    await setState('reconnecting');
    assert.ok(timers.pendingDisconnect);
    assert.notEqual(timers.pendingDisconnect, countdown, 'the next gap starts a fresh countdown');
    assert.equal(phaseOf(), 'hidden');
  });
});

test('outage phase tracks connection failures without rendering any card UI', async () => {
  const setOnline = async (online) => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    await act(async () => window.dispatchEvent(new window.Event(online ? 'online' : 'offline')));
  };
  try {
    await withBanner(async ({ fire, setState, phaseOf, sendBlocked }) => {
      await setState('reconnecting');
      await fire('pendingDisconnect');
      assert.equal(document.querySelector('.composer-connection-line'), null);
      assert.equal(document.querySelector('.remote-boot-line'), null);
      await setOnline(false);
      assert.equal(phaseOf(), 'connecting');
      await setOnline(true);
      await act(async () => reportRemoteConnectionIssue('encryption-timeout'));
      assert.equal(phaseOf(), 'connecting');
      await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
      assert.equal(phaseOf(), 'failed');
      assert.equal(sendBlocked(), true);
      assert.equal(document.querySelector('.composer-connection-line'), null);
      await act(async () => setRemoteConnectionPhase('sync'));
      await setState('syncing');
      assert.equal(phaseOf(), 'hidden');
      assert.equal(sendBlocked(), false);
      await setState('connected');
      await fire('pendingRecovery');
      assert.equal(phaseOf(), 'hidden');
    });
  } finally {
    delete window.navigator.onLine;
  }
});

test('composers can send only while the link is not in an outage, with no connection card rendered', async () => {
  await withBanner(async ({ fire, setState, sendBlocked }) => {
    await setState('reconnecting');
    assert.equal(sendBlocked(), false, 'a short gap sends as usual');
    assert.equal(document.querySelector('.composer-connection-line'), null);
    await fire('pendingDisconnect');
    assert.equal(sendBlocked(), true, 'connecting');
    assert.equal(document.querySelector('.composer-connection-line'), null);
    await fire('pendingFailure');
    assert.equal(sendBlocked(), true, 'failed');
    assert.equal(document.querySelector('.composer-connection-line'), null);
    await setState('connected');
    assert.equal(sendBlocked(), false, 'reconnected');
    assert.equal(document.querySelector('.composer-connection-line'), null);
  });
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
