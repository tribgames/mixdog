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
