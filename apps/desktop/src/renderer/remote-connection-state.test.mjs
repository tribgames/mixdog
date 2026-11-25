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
  setRemoteRedialAt,
  shouldRunRemoteHeartbeat,
  subscribeRemoteConnectionState,
} = await import('./remote-connection-state.ts');
const { ComposerConnectionLine, RemoteConnectionBanner } = await import('./RemoteConnectionBanner.tsx');
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

// The threshold timers are the whole contract of the connection line, so they
// are driven by hand instead of waiting out real seconds: `pendingDisconnect`
// is the 10s countdown, `pendingRecovery` the 3s connected hold and
// `pendingFailure` the 30s the line says it is connecting before it says the
// connection failed.
async function withBanner(run, props = {}) {
  clearRemoteConnectionState();
  const mount = document.querySelector('main');
  const root = createRoot(mount);
  const ids = { pendingDisconnect: 987654, pendingRecovery: 987655, pendingFailure: 987656 };
  const byDelay = { 10_000: 'pendingDisconnect', 3_000: 'pendingRecovery', 30_000: 'pendingFailure' };
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const timers = { pendingDisconnect: null, pendingRecovery: null, pendingFailure: null };
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
  try {
    // The app shell's instance publishes the line to the composers; the boot cover's shows it itself.
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RemoteConnectionBanner, props),
          props.boot ? null : React.createElement(ComposerConnectionLine)
        )
      );
    });
    assert.equal(document.querySelector('.composer-connection-line'), null);
    await run({ timers, fire, setState });
  } finally {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    await act(async () => root.unmount());
    clearRemoteConnectionState();
  }
}

const lineElement = () => document.querySelector('.composer-connection-line');
const phaseOf = () => lineElement()?.dataset.phase ?? null;
const lineButtons = () =>
  [...document.querySelectorAll('.composer-connection-line button')].map((button) => button.textContent);
const press = (label) =>
  act(async () =>
    [...document.querySelectorAll('.composer-connection-line button')]
      .find((button) => button.textContent === label)
      .click()
  );
const countWakes = async (work) => {
  let wakes = 0;
  const onWake = () => wakes++;
  window.addEventListener('mixdog:remote-wake', onWake);
  try {
    await work();
  } finally {
    window.removeEventListener('mixdog:remote-wake', onWake);
  }
  return wakes;
};

test('a persistent disconnect shows diagnostics without resetting its countdown or retry behavior', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    // A short gap — every background return costs one — stays invisible.
    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('websocket');
    });
    assert.equal(lineElement(), null);
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
    assert.equal(lineElement(), null);

    await act(async () => {
      setRemoteConnectionState('reconnecting');
      setRemoteConnectionPhase('encryption');
      reportRemoteConnectionIssue('encryption-timeout');
    });
    await fire('pendingDisconnect');
    const overlay = lineElement();
    assert.ok(overlay);
    // The state in words, never the cause behind it, with a retry that skips the backoff.
    assert.equal(overlay.dataset.phase, 'connecting');
    assert.equal(overlay.getAttribute('role'), 'status');
    assert.equal(overlay.querySelector('.composer-connection-line-title').textContent, 'Connecting to the server');
    assert.doesNotMatch(overlay.textContent, /timeout|encryption/i);
    assert.deepEqual(lineButtons(), ['Retry now']);
    assert.equal(await countWakes(() => press('Retry now')), 1);

    await setState('connected');
    assert.equal(lineElement(), overlay, 'the line stays while the connection proves itself');
    assert.equal(phaseOf(), 'reconnected');
    assert.equal(overlay.querySelector('.composer-connection-line-title').textContent, 'Reconnected');
    assert.deepEqual(lineButtons(), []);
    await fire('pendingRecovery');
    assert.equal(lineElement(), null);
    assert.equal(document.documentElement.dataset.mixdogRemotePhase, 'connected');
    assert.equal(document.documentElement.dataset.mixdogRemoteError, undefined);
  });
});

test('a flapping connection keeps the overlay up until a connection holds', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = lineElement();
    assert.ok(overlay);
    for (let flap = 0; flap < 3; flap++) {
      await setState('connected');
      assert.ok(timers.pendingRecovery);
      assert.equal(lineElement(), overlay, 'a connected blip must not hide the overlay');
      await setState('reconnecting');
      assert.equal(timers.pendingRecovery, null, 'leaving connected abandons the hold');
      assert.equal(lineElement(), overlay, 'the overlay never cycles through hidden');
    }
    await setState('connected');
    await fire('pendingRecovery');
    assert.equal(lineElement(), null);
  });
});

test('a connecting state after the overlay is shown keeps it up', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const overlay = lineElement();
    assert.ok(overlay);
    await setState('connecting');
    assert.equal(lineElement(), overlay);
    await setState('syncing');
    assert.equal(lineElement(), overlay);
    await setState('connected');
    assert.equal(lineElement(), overlay);
    await fire('pendingRecovery');
    assert.equal(lineElement(), null);
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
    assert.ok(lineElement());
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
    assert.equal(lineElement(), null, 'an expired countdown shows nothing while the link is up');
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null);
    await setState('connected');
    assert.equal(lineElement(), null);
  });
  // A countdown that expired during a short healthy sync surfaces only if
  // the link really drops again.
  await withBanner(async ({ fire, setState }) => {
    await setState('connecting');
    await setState('syncing');
    await fire('pendingDisconnect');
    assert.equal(lineElement(), null);
    await setState('reconnecting');
    assert.ok(lineElement());
  });
});

test('a countdown that expires during a connected blip surfaces only if the link drops again', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    assert.equal(lineElement(), null, 'no overlay while the link is up');
    await setState('reconnecting');
    assert.ok(lineElement());
  });
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await setState('connected');
    await fire('pendingDisconnect');
    await fire('pendingRecovery');
    assert.equal(lineElement(), null);
    await setState('reconnecting');
    assert.equal(lineElement(), null, 'a held connection starts the countdown over');
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
      assert.equal(lineElement(), null, 'a return from background never opens on the overlay');
      assert.ok(timers.pendingDisconnect, 'the return starts a fresh countdown');
      await fire('pendingDisconnect');
      assert.ok(lineElement());
      await setVisibility('hidden');
      assert.equal(lineElement(), null, 'going hidden drops a shown overlay');
    });
  } finally {
    delete document.visibilityState;
  }
});

test('a redial counts toward the connection line; a sync on a live socket does not', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    // A resume redial or a re-handshake on a kept socket: the link is down,
    // so a long one earns the line — but nothing before the threshold.
    await setState('connecting');
    assert.ok(timers.pendingDisconnect);
    assert.equal(lineElement(), null);
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
    assert.equal(lineElement(), null);
    // The failure belonged to that sync, not to the next one.
    await setState('syncing');
    assert.equal(timers.pendingDisconnect, null);
  });
});

test('a cold boot has nothing on screen, so every wait counts there and ends in the failed line', async () => {
  await withBanner(
    async ({ timers, fire, setState }) => {
      await setState('connecting');
      assert.ok(timers.pendingDisconnect);
      await setState('syncing');
      await fire('pendingDisconnect');
      // The line stands where the composer will be, over the boot cover.
      assert.ok(document.querySelector('.remote-boot-line > .composer-connection-line'));
      assert.equal(phaseOf(), 'connecting');
      // Issue #134: no endless loading mark — a plain state with a retry.
      await fire('pendingFailure');
      assert.equal(phaseOf(), 'failed');
      assert.equal(lineElement().getAttribute('role'), 'alert');
      assert.equal(
        lineElement().querySelector('.composer-connection-line-title').textContent,
        'Can’t connect to the server'
      );
      assert.deepEqual(lineButtons(), ['Try again'], 'no PC list to return to outside the phone app');
    },
    { boot: true }
  );
});

test('a cold boot the relay answers "PC offline" shows the failed line at once; Try again redials', async () => {
  await withBanner(
    async ({ timers, fire, setState }) => {
      await setState('connecting');
      await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
      assert.equal(phaseOf(), 'failed', 'the relay’s own answer ends the wait without the countdown');
      assert.equal(timers.pendingDisconnect, null);
      assert.equal(await countWakes(() => press('Try again')), 1);
      assert.equal(phaseOf(), 'connecting', 'the line says the retry is under way');
      assert.ok(timers.pendingFailure, 'and how long it waits before saying it failed again');
      // Still offline: the relay says so again.
      await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
      assert.equal(phaseOf(), 'failed');
      // Another failure after it keeps the state up; only a connection ends it.
      await act(async () => reportRemoteConnectionIssue('websocket-error'));
      assert.equal(phaseOf(), 'failed');
      await setState('connected');
      assert.equal(lineElement(), null, 'connected: the cover only waits for the first paint');
      await fire('pendingRecovery');
      assert.equal(lineElement(), null);
    },
    { boot: true }
  );
});

test('in the phone app the failed line also offers the app’s PC list', async () => {
  const calls = [];
  window.mixdogNative = {
    platform: 'android',
    version: '1.3.1',
    call: async (method) => {
      calls.push(method);
      return true;
    },
  };
  try {
    await withBanner(
      async ({ setState }) => {
        await setState('connecting');
        await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
        assert.deepEqual(lineButtons(), ['Other PC', 'Try again']);
        await press('Other PC');
        assert.deepEqual(calls, ['openHostPicker']);
      },
      { boot: true }
    );
  } finally {
    delete window.mixdogNative;
  }
});

test('a live session never turns the PC-offline answer into a blocking state', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
    assert.equal(lineElement(), null, 'the calm countdown still runs');
    assert.ok(timers.pendingDisconnect);
    await fire('pendingDisconnect');
    // Past the countdown the answer stands: one line above the composer, the screen under it untouched.
    assert.equal(phaseOf(), 'failed');
    assert.equal(lineElement().closest('.remote-boot-line'), null);
  });
});

test('a link still down after the line has said it is connecting for a while says it failed', async () => {
  await withBanner(async ({ timers, fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    assert.equal(phaseOf(), 'connecting');
    assert.ok(timers.pendingFailure);
    await fire('pendingFailure');
    assert.equal(phaseOf(), 'failed');
    assert.deepEqual(lineButtons(), ['Try again']);
    assert.equal(await countWakes(() => press('Try again')), 1);
    assert.equal(phaseOf(), 'connecting');
    assert.ok(timers.pendingFailure, 'the retry gets its own wait');
    await setState('connected');
    assert.equal(phaseOf(), 'reconnected');
    assert.equal(timers.pendingFailure, null, 'a connection cancels it');
  });
});

test('the connecting line counts down to the next redial', async () => {
  await withBanner(async ({ fire, setState }) => {
    await setState('reconnecting');
    await fire('pendingDisconnect');
    const note = () => document.querySelector('.composer-connection-line-note')?.textContent ?? null;
    assert.equal(note(), null, 'a dial under way has no countdown');
    await act(async () => setRemoteRedialAt(Date.now() + 3_500));
    assert.equal(note(), '· Retrying in 4s');
    await act(async () => setRemoteRedialAt(null));
    assert.equal(note(), null);
  });
});

test('a cold boot that connects quickly never shows the indicator', async () => {
  await withBanner(
    async ({ timers, fire, setState }) => {
      await setState('connecting');
      await setState('syncing');
      await setState('connected');
      assert.equal(lineElement(), null);
      await fire('pendingRecovery');
      assert.equal(timers.pendingDisconnect, null);
      assert.equal(lineElement(), null);
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
    assert.equal(lineElement(), null);
    await fire('pendingRecovery');
    assert.equal(timers.pendingDisconnect, null, 'a held connection cancels the countdown');
    assert.equal(lineElement(), null);
    await setState('reconnecting');
    assert.ok(timers.pendingDisconnect);
    assert.notEqual(timers.pendingDisconnect, countdown, 'the next gap starts a fresh countdown');
    assert.equal(lineElement(), null);
  });
});

test('the line names the state, never its cause, and never blocks the screen', async () => {
  const setOnline = async (online) => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
    await act(async () => window.dispatchEvent(new window.Event(online ? 'online' : 'offline')));
  };
  const title = () => lineElement().querySelector('.composer-connection-line-title').textContent;
  try {
    await withBanner(async ({ fire, setState }) => {
      await setState('reconnecting');
      await fire('pendingDisconnect');
      // A line in the composer region, not a layer over the screen.
      assert.equal(lineElement().className, 'composer-connection-line');
      assert.equal(document.querySelector('.remote-boot-line'), null);
      // This device's own network or a failed attempt: the shim retries each on its own, and the line says only that.
      await setOnline(false);
      assert.equal(title(), 'Connecting to the server');
      await setOnline(true);
      await act(async () => reportRemoteConnectionIssue('encryption-timeout'));
      assert.equal(title(), 'Connecting to the server');
      // The relay saying the PC is offline is an answer: the line says the connection failed, without the cause.
      await act(async () => reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE));
      assert.equal(title(), 'Can’t connect to the server');
      assert.doesNotMatch(lineElement().textContent, /offline|4002/i);
      await act(async () => setRemoteConnectionPhase('sync'));
      await setState('syncing');
      assert.equal(title(), 'Reconnected', 'a socket that is up syncs the view under the line');
      await setState('connected');
      await fire('pendingRecovery');
      assert.equal(lineElement(), null);
    });
  } finally {
    delete window.navigator.onLine;
  }
});

test('composers can send only while the line does not say the link is down', async () => {
  const { useRemoteSendBlocked } = await import('./RemoteConnectionBanner.tsx');
  const seen = [];
  function Probe() {
    seen.push(useRemoteSendBlocked());
    return null;
  }
  const probe = createRoot(document.createElement('div'));
  await act(async () => probe.render(React.createElement(Probe)));
  try {
    await withBanner(async ({ fire, setState }) => {
      await setState('reconnecting');
      assert.equal(seen.at(-1), false, 'a short gap sends as usual');
      await fire('pendingDisconnect');
      assert.equal(seen.at(-1), true, 'connecting');
      await fire('pendingFailure');
      assert.equal(seen.at(-1), true, 'failed');
      await setState('connected');
      assert.equal(seen.at(-1), false, 'reconnected');
    });
  } finally {
    await act(async () => probe.unmount());
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
