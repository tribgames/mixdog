import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserGuestCdp } from './cdp.ts';
import { BrowserGuestStateStore } from './guest-state.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(send) {
  const state = new BrowserGuestStateStore();
  const guest = {};
  const cdp = createBrowserGuestCdp({
    state, interceptFetchPatterns: () => [], matchInterceptRule: () => undefined,
  });
  return { guest, cdp, debug: { sendCommand: send } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('local input admission is checked again after transport cleanup and immediately before dispatch', async () => {
  const running = deferred();
  const started = deferred();
  const calls = [];
  const { guest, cdp, debug } = fixture(method => {
    calls.push(method);
    if (method === 'Input.dispatchMouseEvent') { started.resolve(); return running.promise; }
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const previous = cdp.sendCdp(guest, debug, 'Input.dispatchMouseEvent', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('interrupted'));
  await assert.rejects(previous, /interrupted/);
  let current = true;
  const input = cdp.sendCdpInput(guest, debug, 'Input.insertText', { text: 'old edit' }, undefined, undefined,
    () => { if (!current) throw new Error('Browser page changed; input was not sent.'); });
  const rejected = assert.rejects(input, /page changed/);
  try {
    await tick();
    current = false;
    running.resolve({});
    await rejected;
    assert.deepEqual(calls, ['Input.dispatchMouseEvent']);
    await cdp.sendCdpInput(guest, debug, 'Input.insertText', { text: 'fresh' }, undefined, undefined, () => {});
    assert.deepEqual(calls, ['Input.dispatchMouseEvent', 'Input.insertText']);
  } finally { running.resolve({}); }
});

test('already-cancelled CDP operations dispatch nothing', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before dispatch'));
  const calls = [];
  const { guest, cdp, debug } = fixture(async method => { calls.push(method); });
  for (const method of ['Input.insertText', 'Runtime.evaluate', 'Runtime.callFunctionOn']) {
    await assert.rejects(
      cdp.sendCdp(guest, debug, method, {}, 1000, controller.signal),
      /cancelled before dispatch/,
    );
  }
  assert.deepEqual(calls, []);
});

test('script cancellation terminates the owning CDP target and fences page reuse until both operations settle', async () => {
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn']) {
    const running = deferred();
    const termination = deferred();
    const started = deferred();
    const calls = [];
    const { guest, cdp, debug } = fixture((name, _params, sessionId) => {
      calls.push({ name, sessionId });
      if (name === method) { started.resolve(); return running.promise; }
      if (name === 'Runtime.terminateExecution') return termination.promise;
      return Promise.resolve({});
    });
    const controller = new AbortController();
    const work = cdp.sendCdp(guest, debug, method, {}, 1000, controller.signal, 'child-frame');
    await started.promise;
    controller.abort(new Error('cancelled during execution'));
    await assert.rejects(work, /cancelled during execution/);
    let idle = false;
    const idleWait = cdp.waitForIdle(guest).then(() => { idle = true; });
    const next = cdp.sendCdp(guest, debug, 'Input.insertText', {}, 1000);
    await tick();
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
  const running = deferred();
  const calls = [];
  const { guest, cdp, debug } = fixture((method, _params, sessionId) => {
    calls.push({ method, sessionId });
    if (method === 'Runtime.callFunctionOn') return running.promise;
    if (method === 'Runtime.terminateExecution') running.reject(new Error('terminated'));
    return Promise.resolve({});
  });
  await assert.rejects(
    cdp.sendCdp(guest, debug, 'Runtime.callFunctionOn', {}, 5, undefined, 'frame-2'),
    /timed out/,
  );
  await cdp.waitForIdle(guest);
  assert.deepEqual(calls.at(-1), { method: 'Runtime.terminateExecution', sessionId: 'frame-2' });
});

test('cancelled input is not replayed and dialog cleanup can release its pending dispatch', async () => {
  const running = deferred();
  const started = deferred();
  const calls = [];
  const { guest, cdp, debug } = fixture(method => {
    calls.push(method);
    if (method === 'Input.dispatchMouseEvent') { started.resolve(); return running.promise; }
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
  const running = deferred();
  const started = deferred();
  const calls = [];
  const { guest, cdp, debug } = fixture(method => {
    calls.push(method);
    if (method === 'Runtime.evaluate') { started.resolve(); return running.promise; }
    if (method === 'Runtime.terminateExecution') return Promise.reject(new Error('target is busy'));
    return Promise.resolve({});
  });
  const controller = new AbortController();
  const work = cdp.sendCdp(guest, debug, 'Runtime.evaluate', {}, 1000, controller.signal);
  await started.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(work, /cancelled/);
  let idle = false;
  const barrier = cdp.waitForIdle(guest).then(() => { idle = true; });
  await cdp.sendCdp({}, debug, 'Input.insertText');
  await tick();
  assert.equal(idle, false);
  assert.equal(calls.filter(method => method === 'Input.insertText').length, 1);
  running.resolve({});
  await barrier;
});

test('cleanup wait timeout never lifts the fence on an unfinished dispatch', async () => {
  const running = deferred();
  const started = deferred();
  const calls = [];
  const { guest, cdp, debug } = fixture(method => {
    calls.push(method);
    if (method === 'Input.dispatchKeyEvent') { started.resolve(); return running.promise; }
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
