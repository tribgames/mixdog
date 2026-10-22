import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Event', 'navigator'],
});

const { installRemoteLiveness } = await import('./remote-shim-liveness.ts');

test('a wake while the page is still frozen waits for resume before dialing', () => {
  let visibility = 'hidden';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  let connects = 0;
  const ctx = {
    socket: null,
    openingSocket: null,
    openingStartedAt: 0,
    retryMs: 500,
    backgroundSuspended: true,
    resyncOnWake: false,
    connect: async () => {
      connects += 1;
      return null;
    },
    fire: () => {},
  };
  installRemoteLiveness(ctx);
  document.dispatchEvent(new Event('freeze'));
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  assert.equal(connects, 0, 'no socket may be opened before the page is thawed');
  document.dispatchEvent(new Event('resume'));
  assert.equal(connects, 1);
  assert.equal(ctx.backgroundSuspended, false);
});

test('reconnect delays are jittered inside [step, next step] and keep the 500ms floor and 10s cap', () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const realSetTimeout = window.setTimeout;
  const realRandom = Math.random;
  const delays = [];
  const ctx = {
    socket: null,
    openingSocket: null,
    openingStartedAt: 0,
    retryMs: 500,
    reconnectTimer: null,
    everConnected: true,
    backgroundSuspended: false,
    resyncOnWake: false,
    connect: async () => null,
    fire: () => {},
  };
  installRemoteLiveness(ctx);
  window.setTimeout = (_fn, ms) => {
    delays.push(ms);
    return 1;
  };
  const draw = (random, fleet = false) => {
    Math.random = () => random;
    ctx.reconnectTimer = null;
    ctx.scheduleReconnect(fleet);
    return delays.at(-1);
  };
  try {
    // The first retry of an outage — a resume, a dead socket — leaves at
    // once; the next starts the backoff.
    ctx.retryMs = 0;
    assert.equal(draw(1), 0);
    assert.equal(ctx.retryMs, 500);
    // A live leg the relay closed: every phone retries in this same instant,
    // so that first retry is spread over [0, 1.5 s].
    ctx.retryMs = 0;
    assert.equal(draw(0, true), 0);
    ctx.retryMs = 0;
    assert.equal(draw(1, true), 1_500);
    ctx.retryMs = 0;
    assert.equal(draw(0.5, true), 750);
    assert.equal(ctx.retryMs, 500);
    // Then anywhere in [500, 1000], never the bare 500 every phone shares.
    assert.equal(draw(0), 500);
    ctx.retryMs = 500;
    assert.equal(draw(1), 1000);
    ctx.retryMs = 500;
    assert.equal(draw(0.5), 750);
    assert.equal(ctx.retryMs, 1000, 'the step still doubles');
    // Near the cap the range is clamped to it; at the cap it keeps a real
    // spread, [5 s, 10 s], so capped retries never line up again.
    ctx.retryMs = 8_000;
    assert.equal(draw(1), 10_000);
    assert.equal(ctx.retryMs, 10_000);
    assert.equal(draw(1), 10_000);
    assert.equal(draw(0), 5_000);
    assert.equal(draw(0.5), 7_500);
    const capped = new Set();
    for (let index = 0; index < 20; index++) capped.add(draw(realRandom()));
    assert.ok(capped.size > 1, 'repeated capped retries are randomised');
    for (const delay of capped) assert.ok(delay >= 5_000 && delay <= 10_000, `capped delay ${delay}`);
    for (let index = 0; index < 50; index++) {
      // Every step the backoff can reach: 500, 1000, … 8000, then the cap.
      ctx.retryMs = Math.min(10_000, 500 * 2 ** (index % 6));
      const delay = draw(realRandom());
      assert.ok(delay >= 500 && delay <= 10_000, `delay ${delay} within bounds`);
    }
  } finally {
    window.setTimeout = realSetTimeout;
    Math.random = realRandom;
    delete document.visibilityState;
  }
});

const { REMOTE_DESKTOP_OFFLINE_CLOSE, REMOTE_WAKE_EVENT, forgetRemoteDesktopOffline, reportRemoteConnectionIssue } =
  await import('./remote-connection-state.ts');

// A scheduler whose timers never fire: `delays` records every wait asked for.
// Timer ids are unique across harnesses, so earlier contexts still listening
// on window cannot be mistaken for the one under test.
let nextTimerId = 0;
const reconnectHarness = () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const realRandom = Math.random;
  const delays = [];
  const cleared = [];
  const ctx = {
    socket: null,
    openingSocket: null,
    openingStartedAt: 0,
    retryMs: 0,
    reconnectTimer: null,
    everConnected: true,
    backgroundSuspended: false,
    resyncOnWake: false,
    connects: 0,
    connect: async () => {
      ctx.connects += 1;
      return null;
    },
    fire: () => {},
  };
  installRemoteLiveness(ctx);
  window.setTimeout = (_fn, ms) => {
    delays.push(ms);
    return ++nextTimerId;
  };
  window.clearTimeout = (id) => {
    cleared.push(id);
  };
  // One retry whose timer has fired: it asks for the next wait.
  const draw = (random) => {
    Math.random = () => random;
    ctx.reconnectTimer = null;
    ctx.scheduleReconnect();
    return delays.at(-1);
  };
  const restore = () => {
    window.setTimeout = realSetTimeout;
    window.clearTimeout = realClearTimeout;
    Math.random = realRandom;
    forgetRemoteDesktopOffline();
    delete document.visibilityState;
  };
  return { ctx, delays, cleared, draw, restore, random: realRandom };
};
const reportOfflineClose = () =>
  reportRemoteConnectionIssue('websocket-closed', undefined, REMOTE_DESKTOP_OFFLINE_CLOSE);
const reportOtherFailure = () => reportRemoteConnectionIssue('websocket-closed', undefined, 1006);

test('repeated PC-offline closes lengthen the reconnect delay past 10s up to the 60s ceiling', () => {
  const { ctx, draw, restore, random } = reconnectHarness();
  try {
    reportOfflineClose();
    assert.equal(draw(1), 0, 'the first retry still leaves at once');
    assert.equal(ctx.retryMs, 500);
    // Upper edge of each [step, next step] draw: the step keeps doubling.
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(() => draw(1)),
      [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
    );
    assert.equal(ctx.retryMs, 60_000);
    // At the ceiling the wait is spread over [30 s, 60 s], never the bare cap.
    assert.equal(draw(0), 30_000);
    assert.equal(draw(0.5), 45_000);
    for (let index = 0; index < 50; index++) {
      ctx.retryMs = Math.min(60_000, 500 * 2 ** (index % 8));
      const delay = draw(random());
      assert.ok(delay >= 500 && delay <= 60_000, `offline delay ${delay} within bounds`);
    }
  } finally {
    restore();
  }
});

test('a failure that is not "PC offline" keeps the 10s ceiling, also after a long offline backoff', () => {
  const { ctx, draw, restore } = reconnectHarness();
  try {
    reportOtherFailure();
    ctx.retryMs = 500;
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map(() => draw(1)),
      [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]
    );
    assert.equal(ctx.retryMs, 10_000);
    assert.equal(draw(0), 5_000);
    // The relay's latest answer decides: a different failure after a grown
    // offline backoff brings the ceiling back at once.
    reportOfflineClose();
    ctx.retryMs = 60_000;
    assert.equal(draw(0), 30_000);
    reportRemoteConnectionIssue('websocket-error');
    assert.equal(draw(1), 10_000);
    assert.equal(ctx.retryMs, 10_000);
    assert.equal(draw(0), 5_000);
  } finally {
    restore();
  }
});

test('a wake after a long offline backoff redials at once and restarts the backoff from the minimum', () => {
  const { ctx, delays, cleared, draw, restore } = reconnectHarness();
  try {
    reportOfflineClose();
    ctx.retryMs = 32_000;
    assert.equal(draw(1), 60_000);
    const longWait = ctx.reconnectTimer;
    assert.notEqual(longWait, null, 'the 60 s wait is armed');
    const connectsBefore = ctx.connects;
    window.dispatchEvent(new Event(REMOTE_WAKE_EVENT));
    assert.equal(ctx.connects, connectsBefore + 1, 'the wake dials without waiting out the backoff');
    assert.equal(ctx.retryMs, 0);
    assert.ok(cleared.includes(longWait), 'the long wait no longer stands in the way');
    assert.equal(ctx.reconnectTimer, null);
    // The redial is refused again: a fresh wait is armed, not swallowed.
    reportOfflineClose();
    const armed = delays.length;
    ctx.scheduleReconnect();
    assert.equal(delays.length, armed + 1);
    assert.equal(delays.at(-1), 0, 'the first retry after a wake leaves at once');
    assert.equal(ctx.retryMs, 500, 'and the backoff restarts from the minimum');
    assert.equal(draw(0), 500);
    assert.equal(draw(1), 2_000);
  } finally {
    restore();
  }
});

test('a wake without a freeze dials immediately', () => {
  let connects = 0;
  const ctx = {
    socket: null,
    openingSocket: null,
    openingStartedAt: 0,
    retryMs: 500,
    backgroundSuspended: false,
    resyncOnWake: false,
    connect: async () => {
      connects += 1;
      return null;
    },
    fire: () => {},
  };
  installRemoteLiveness(ctx);
  document.dispatchEvent(new Event('visibilitychange'));
  assert.ok(connects >= 1);
});
