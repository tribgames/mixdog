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
