import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserGuestCdp } from './cdp.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { MAX_CHILD_CDP_SESSIONS } from './command.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(send = async () => ({})) {
  const state = new BrowserGuestStateStore();
  const calls = [];
  const guest = new EventEmitter();
  let attached = false;
  let destroyed = false;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => {
      attached = false;
      debug.emit('detach', {}, 'test detach');
    },
    sendCommand: (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return send(method, params, sessionId);
    },
  });
  Object.assign(guest, {
    debugger: debug,
    isDestroyed: () => destroyed,
    getURL: () => 'about:blank',
    destroy: () => { destroyed = true; guest.emit('destroyed'); },
  });
  const cdp = createBrowserGuestCdp({
    state, interceptFetchPatterns: () => [], matchInterceptRule: () => undefined,
  });
  const attachChild = id => debug.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: id, targetInfo: { type: 'iframe', targetId: id, url: 'https://frame.test' },
  });
  return { state, guest, debug, cdp, calls, attachChild };
}

test('root observes frames without recursive auto-attach or forced excess-frame detach', async () => {
  const f = fixture();
  await f.cdp.guestDebugger(f.guest);
  for (let i = 0; i <= MAX_CHILD_CDP_SESSIONS; i++) f.attachChild(`child-${i}`);
  await Promise.all([...f.state.for(f.guest).cdpSessions.values()].map(child => child.ready));
  assert.equal(f.state.for(f.guest).cdpSessions.size, MAX_CHILD_CDP_SESSIONS);
  assert.deepEqual(f.calls.filter(call => call.method === 'Target.setAutoAttach').map(call => call.sessionId), [undefined]);
  assert.equal(f.calls.some(call => call.method === 'Target.detachFromTarget'), false);
  assert.ok(f.calls.some(call => call.method === 'Fetch.enable' && call.sessionId === 'child-0'));
  await f.cdp.detach(f.guest);
  assert.equal(f.state.for(f.guest).cdpSessions.size, 0);
});

test('detach during initialization prevents late auto-attach and permits a fresh connection', async () => {
  const pending = deferred();
  let hold = true;
  const f = fixture(method => method === 'Page.enable' && hold ? pending.promise : Promise.resolve({}));
  const ready = f.cdp.guestDebugger(f.guest);
  const rejected = assert.rejects(ready, /detach/);
  await tick();
  await f.cdp.detach(f.guest);
  hold = false;
  const next = f.cdp.guestDebugger(f.guest);
  pending.resolve({});
  await rejected;
  await next;
  assert.equal(await f.cdp.guestDebugger(f.guest), f.debug);
  assert.equal(f.debug.listenerCount('message'), 1);
  assert.equal(f.calls.filter(call => call.method === 'Target.setAutoAttach').length, 1);
  await f.cdp.detach(f.guest);
});

test('closing a page before its initial document commits never attaches the debugger', async () => {
  const pending = deferred();
  const f = fixture();
  f.guest.getURL = () => '';
  f.guest.loadURL = () => pending.promise;
  const ready = f.cdp.guestDebugger(f.guest);
  const rejected = assert.rejects(ready, /unavailable/);
  f.guest.destroy();
  pending.resolve();
  await rejected;
  assert.equal(f.debug.isAttached(), false);
  assert.deepEqual(f.calls, []);
});

test('frame removal during initialization does not start late observation domains', async () => {
  const pending = deferred();
  const f = fixture((method, _params, sessionId) =>
    method === 'Page.enable' && sessionId ? pending.promise : Promise.resolve({}));
  await f.cdp.guestDebugger(f.guest);
  f.attachChild('removed');
  const ready = f.state.for(f.guest).cdpSessions.get('removed').ready;
  f.debug.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'removed' });
  pending.resolve({});
  await ready;
  assert.equal(f.calls.some(call => call.method === 'Network.enable' && call.sessionId === 'removed'), false);
  await f.cdp.detach(f.guest);
});

test('bridge uninstall blocks concurrent reattachment until detach finishes', async () => {
  const pending = deferred();
  const f = fixture(method => method === 'Runtime.evaluate' ? pending.promise : Promise.resolve({}));
  await f.cdp.guestDebugger(f.guest);
  const closing = f.cdp.detach(f.guest, { uninstallScript: 'void 0' });
  await assert.rejects(f.cdp.guestDebugger(f.guest), /unavailable/);
  pending.resolve({});
  await closing;
  assert.equal(f.debug.isAttached(), false);
});
