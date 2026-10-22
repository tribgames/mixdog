import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserGuestCdp } from './cdp.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { waitUntil } from '../../../../../src/runtime/shared/wait-until.test-support.mjs';

function fixture(send) {
  const state = new BrowserGuestStateStore();
  const guest = {};
  const cdp = createBrowserGuestCdp({
    state,
    interceptFetchPatterns: () => [],
    matchInterceptRule: () => undefined,
  });
  return { guest, cdp, debug: { sendCommand: send }, state };
}

// Drains the already-resolved microtasks of the mocked CDP transport (no real
// I/O is involved) before asserting that a fenced call stayed undispatched.
// Anything expected to HAPPEN is awaited with waitUntil instead.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a script held by an open dialog is not terminated, so the answer still reaches the page', async () => {
  const running = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug, state } = fixture((method) => {
    calls.push(method);
    if (method === 'Runtime.callFunctionOn') return running.promise;
    return Promise.resolve({});
  });
  state.for(guest).pendingDialog = { type: 'prompt', message: 'Name?', openedAt: Date.now(), bridgeRequestId: 'q1' };
  await assert.rejects(cdp.sendCdp(guest, debug, 'Runtime.callFunctionOn', {}, 5), /timed out/);
  assert.deepEqual(calls, ['Runtime.callFunctionOn']);
  // The fence still holds until the held call settles once the dialog is answered.
  running.resolve({});
  await cdp.waitForIdle(guest);
});

test('local input admission is checked again after transport cleanup and immediately before dispatch', async () => {
  const running = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug } = fixture((method) => {
    calls.push(method);
    if (method === 'Input.dispatchMouseEvent') {
      started.resolve();
      return running.promise;
    }
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const previous = cdp.sendCdp(guest, debug, 'Input.dispatchMouseEvent', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('interrupted'));
  await assert.rejects(previous, /interrupted/);
  let current = true;
  const input = cdp.sendCdpInput(guest, debug, 'Input.insertText', { text: 'old edit' }, undefined, undefined, () => {
    if (!current) throw new Error('Browser page changed; input was not sent.');
  });
  const rejected = assert.rejects(input, /page changed/);
  try {
    await tick(); // negative: the fenced input must not have dispatched
    current = false;
    running.resolve({});
    await rejected;
    assert.deepEqual(calls, ['Input.dispatchMouseEvent']);
    await cdp.sendCdpInput(guest, debug, 'Input.insertText', { text: 'fresh' }, undefined, undefined, () => {});
    assert.deepEqual(calls, ['Input.dispatchMouseEvent', 'Input.insertText']);
  } finally {
    running.resolve({});
  }
});

test('already-cancelled CDP operations dispatch nothing', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before dispatch'));
  const calls = [];
  const { guest, cdp, debug } = fixture(async (method) => {
    calls.push(method);
  });
  for (const method of ['Input.insertText', 'Runtime.evaluate', 'Runtime.callFunctionOn']) {
    await assert.rejects(cdp.sendCdp(guest, debug, method, {}, 1000, controller.signal), /cancelled before dispatch/);
  }
  assert.deepEqual(calls, []);
});

test('script cancellation terminates the owning CDP target and fences page reuse until both operations settle', async () => {
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn']) {
    const running = Promise.withResolvers();
    const termination = Promise.withResolvers();
    const started = Promise.withResolvers();
    const calls = [];
    const { guest, cdp, debug } = fixture((name, _params, sessionId) => {
      calls.push({ name, sessionId });
      if (name === method) {
        started.resolve();
        return running.promise;
      }
      if (name === 'Runtime.terminateExecution') return termination.promise;
      return Promise.resolve({});
    });
    const controller = new AbortController();
    const work = cdp.sendCdp(guest, debug, method, {}, 1000, controller.signal, 'child-frame');
    await started.promise;
    controller.abort(new Error('cancelled during execution'));
    await assert.rejects(work, /cancelled during execution/);
    let idle = false;
    const idleWait = cdp.waitForIdle(guest).then(() => {
      idle = true;
    });
    const next = cdp.sendCdp(guest, debug, 'Input.insertText', {}, 1000);
    await waitUntil(() => calls.length >= 2, { message: 'terminateExecution dispatched' });
    assert.deepEqual(calls, [
      { name: method, sessionId: 'child-frame' },
      { name: 'Runtime.terminateExecution', sessionId: 'child-frame' },
    ]);
    termination.resolve({});
    await tick();
    assert.equal(idle, false);
    running.reject(new Error('Execution was terminated'));
    await Promise.all([next, idleWait]);
    assert.equal(idle, true);
    assert.equal(calls.at(-1).name, 'Input.insertText');
  }
});

test('timed-out element scripts terminate in the child session rather than the root', async () => {
  const running = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug } = fixture((method, _params, sessionId) => {
    calls.push({ method, sessionId });
    if (method === 'Runtime.callFunctionOn') return running.promise;
    if (method === 'Runtime.terminateExecution') running.reject(new Error('terminated'));
    return Promise.resolve({});
  });
  await assert.rejects(cdp.sendCdp(guest, debug, 'Runtime.callFunctionOn', {}, 5, undefined, 'frame-2'), /timed out/);
  await cdp.waitForIdle(guest);
  assert.deepEqual(calls.at(-1), { method: 'Runtime.terminateExecution', sessionId: 'frame-2' });
});

test('cancelled input is not replayed and dialog cleanup can release its pending dispatch', async () => {
  const running = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug } = fixture((method) => {
    calls.push(method);
    if (method === 'Input.dispatchMouseEvent') {
      started.resolve();
      return running.promise;
    }
    if (method === 'Page.handleJavaScriptDialog') running.resolve({});
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const work = cdp.sendCdp(guest, debug, 'Input.dispatchMouseEvent', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('cancelled input'));
  await assert.rejects(work, /cancelled input/);
  const nextController = new AbortController();
  const next = cdp.sendCdp(guest, debug, 'Input.insertText', {}, 1000, nextController.signal);
  nextController.abort(new Error('cancelled while fenced'));
  await assert.rejects(next, /cancelled while fenced/);
  await cdp.sendCdp(guest, debug, 'Page.handleJavaScriptDialog');
  await cdp.waitForIdle(guest);
  assert.deepEqual(calls, ['Input.dispatchMouseEvent', 'Page.handleJavaScriptDialog']);
});

test('a rejected termination does not release a still-running script, and another page remains usable', async () => {
  const running = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug } = fixture((method) => {
    calls.push(method);
    if (method === 'Runtime.evaluate') {
      started.resolve();
      return running.promise;
    }
    if (method === 'Runtime.terminateExecution') return Promise.reject(new Error('target is busy'));
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const work = cdp.sendCdp(guest, debug, 'Runtime.evaluate', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  let idle = false;
  const barrier = cdp.waitForIdle(guest).then(() => {
    idle = true;
  });
  await cdp.sendCdp({}, debug, 'Input.insertText');
  await tick();
  assert.equal(idle, false);
  assert.equal(calls.filter((method) => method === 'Input.insertText').length, 1);
  running.resolve({});
  await barrier;
});

// Chromium (Electron 3x) never answers a command that was in flight on an
// out-of-process frame whose target then detached (an ad iframe swapped out);
// the reply only comes when the whole page is destroyed. A timeout on such a
// command used to fence the page for good: every later command failed with
// "browser execution cleanup is pending" until the app restarted.
test('a timed-out command on a frame target that detaches releases the page fence', async () => {
  const calls = [];
  const never = new Promise(() => {});
  const guest = new EventEmitter();
  let attached = false;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    sendCommand: (method, _params, sessionId) => {
      calls.push({ method, sessionId });
      if (sessionId === 'ad-frame' && ['Runtime.evaluate', 'Runtime.terminateExecution'].includes(method)) {
        return never;
      }
      return Promise.resolve({});
    },
  });
  Object.assign(guest, {
    debugger: debug,
    isDestroyed: () => false,
    getURL: () => 'https://page.test/',
    getUserAgent: () => 'Fixture/1.0',
  });
  const state = new BrowserGuestStateStore();
  const cdp = createBrowserGuestCdp({ state, interceptFetchPatterns: () => [], matchInterceptRule: () => undefined });
  await cdp.guestDebugger(guest);
  debug.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: 'ad-frame',
    targetInfo: { type: 'iframe', targetId: 'ad-frame', url: 'https://ads.test/' },
  });
  await assert.rejects(cdp.sendCdp(guest, debug, 'Runtime.evaluate', {}, 5, undefined, 'ad-frame'), /timed out/);
  const next = cdp.sendCdp(guest, debug, 'Runtime.evaluate', { expression: 'document.title' });
  await tick(); // negative: still fenced while the frame's script may be running
  assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate' && !call.sessionId).length, 0);
  // Another page is never held by this one's fence.
  await cdp.sendCdp({}, debug, 'Input.insertText');
  debug.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'ad-frame' });
  await cdp.waitForIdle(guest);
  await next;
  assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate' && !call.sessionId).length, 1);
  assert.equal(state.for(guest).cdpSessions.has('ad-frame'), false);
});

test('cleanup wait timeout never lifts the fence on an unfinished dispatch', async () => {
  const running = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const { guest, cdp, debug } = fixture((method) => {
    calls.push(method);
    if (method === 'Input.dispatchKeyEvent') {
      started.resolve();
      return running.promise;
    }
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const work = cdp.sendCdp(guest, debug, 'Input.dispatchKeyEvent', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  await assert.rejects(cdp.waitForIdle(guest), /cleanup is pending/);
  const next = cdp.sendCdp(guest, debug, 'Input.insertText');
  await tick();
  assert.deepEqual(calls, ['Input.dispatchKeyEvent']);
  running.resolve({});
  await next;
  assert.deepEqual(calls, ['Input.dispatchKeyEvent', 'Input.insertText']);
});
