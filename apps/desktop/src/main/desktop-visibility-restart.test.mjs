import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopServiceRegistry } from '../../../../src/standalone/desktop-service-registry.mjs';
import { createDesktopServiceStateSync } from './desktop-service-state-sync.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';

const moduleUrl = new URL(
  '../../../../src/standalone/test-fixtures/lifecycle-desktop-service.mjs',
  import.meta.url
).href;

function fixture(t) {
  const frames = [];
  const registrations = [];
  const listeners = new Map();
  let created = 0;
  const subscribe = (kind, listener) => {
    listeners.set(kind, listener);
    return () => listeners.delete(kind);
  };
  const host = {
    getSnapshot: () => null,
    subscribe: (listener) => subscribe('state', listener),
    subscribeSessions: (listener) => subscribe('sessions', listener),
    subscribeAgentPool: (listener) => subscribe('agents', listener),
    subscribeSessionStates: (listener) => subscribe('lane', listener),
    async setVisibleSessions(ids) {
      registrations.push([...ids]);
      return true;
    },
  };
  const registry = new DesktopServiceRegistry({
    runtime: {
      makeAdapter({ emit }) {
        created += 1;
        const sync = createDesktopServiceStateSync({ host, emit });
        return {
          invoke: (_method, args) => sync.setDeliveryFilter(args),
          control: (message) => sync.control(message),
          releaseClient: (epoch) => sync.releaseClient(epoch),
          dispose: () => sync.dispose(),
        };
      },
    },
    onFrame: (frame) => frames.push(frame.message),
  });
  t.after(() => registry.dispose());
  const open = (desktopId, ctx) => registry.init({ desktopId, moduleUrl }, ctx);
  const show = (desktopId, ids, version, ctx) =>
    registry.invoke({ desktopId, method: 'setVisibleSessions', args: [ids, version] }, ctx);
  const publish = (sessionId, text) =>
    listeners.get('lane')({
      sessionId,
      snapshot: { sessionId, items: [{ id: text, kind: 'user', text }] },
      frameSource: 'live',
    });
  return { registry, frames, registrations, listeners, open, show, publish, created: () => created };
}

test('a restarted desktop can register version one on the retained service and receive live conversation rows', async (t) => {
  const f = fixture(t);
  const old = { clientToken: 'old-client' };
  const current = { clientToken: 'replacement-client' };
  const first = await f.open('old_desktop', old);
  await f.show(first.desktopId, ['old_session'], 5, old);
  f.registry.releaseClient(old.clientToken);
  const replacement = await f.open('replacement_desktop', current);
  assert.equal(replacement.desktopId, first.desktopId);
  assert.equal(f.created(), 1, 'restarting the desktop must not replace its background service');
  assert.equal(await f.show(replacement.desktopId, ['current_session'], 1, current), true);
  assert.deepEqual(f.registrations, [['old_session'], [], ['current_session']]);
  f.frames.length = 0;
  const decoder = createSnapshotDeltaDecoder();
  for (const text of ['sent message', 'working progress', 'completed answer']) {
    f.publish('current_session', text);
    const frame = f.frames.at(-1);
    assert.equal(frame?.kind, 'session-state');
    const decoded = decoder.decode(frame.wire);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.snapshot.items[0].text, text);
  }
  assert.equal(f.frames.length, 3);
  f.listeners.get('agents')([{ id: 'worker', status: 'running' }]);
  assert.equal(f.frames.at(-1).kind, 'agent-pool');
});

test('late registrations from a previous desktop cannot replace the current conversation filter', async (t) => {
  const f = fixture(t);
  const old = { clientToken: 'old-client' };
  const current = { clientToken: 'current-client' };
  const service = await f.open('old_desktop', old);
  await f.show(service.desktopId, ['old_session'], 40, old);
  await f.open('current_desktop', current);
  await f.show(service.desktopId, ['current_session'], 1, current);
  f.registry.releaseClient(old.clientToken);
  await assert.rejects(
    f.show(service.desktopId, ['old_session'], 41, old),
    /desktop service client is not initialized/
  );
  f.frames.length = 0;
  f.publish('old_session', 'must stay hidden');
  f.publish('current_session', 'must stay live');
  assert.deepEqual(
    f.frames.filter((frame) => frame.kind === 'session-state').map((frame) => frame.sessionId),
    ['current_session']
  );
});

test('out-of-order and equal registrations stay fenced within one desktop connection', async (t) => {
  const f = fixture(t);
  const current = { clientToken: 'current-client' };
  const service = await f.open('desktop', current);
  await f.show(service.desktopId, ['current_session'], 2, current);
  await f.show(service.desktopId, ['old_session'], 1, current);
  await f.show(service.desktopId, ['old_session'], 2, current);
  assert.deepEqual(f.registrations, [['current_session']]);
  f.frames.length = 0;
  f.publish('old_session', 'must stay hidden');
  f.publish('current_session', 'must stay live');
  assert.deepEqual(
    f.frames.filter((frame) => frame.kind === 'session-state').map((frame) => frame.sessionId),
    ['current_session']
  );
});

test('unversioned legacy registrations remain supported', async (t) => {
  const f = fixture(t);
  const service = await f.open('desktop');
  await f.show(service.desktopId, ['old_session'], 5);
  await f.show(service.desktopId, ['current_session']);
  f.frames.length = 0;
  f.publish('current_session', 'legacy live update');
  assert.equal(f.frames.at(-1)?.sessionId, 'current_session');
});

test('concurrent desktops keep independent counters and the survivor stays live after the newer one disconnects', async (t) => {
  const f = fixture(t);
  const a = { clientToken: 'desktop-a' };
  const b = { clientToken: 'desktop-b' };
  const service = await f.open('desktop_a', a);
  await f.show(service.desktopId, ['a_session'], 1, a);
  await f.open('desktop_b', b);
  await f.show(service.desktopId, ['b_session'], 1, b);
  await f.open('desktop_a', a);
  await f.show(service.desktopId, ['a_current'], 100, a);
  assert.deepEqual(f.registrations.at(-1), ['a_current', 'b_session']);
  f.frames.length = 0;
  f.publish('a_current', 'a is live');
  f.publish('b_session', 'b is live');
  assert.deepEqual(
    f.frames.filter((frame) => frame.kind === 'session-state').map((frame) => frame.sessionId),
    ['a_current', 'b_session']
  );
  f.registry.releaseClient(b.clientToken);
  assert.deepEqual(f.registrations.at(-1), ['a_current']);
  await f.show(service.desktopId, ['a_next'], 101, a);
  assert.deepEqual(f.registrations.at(-1), ['a_next']);
  f.frames.length = 0;
  f.publish('a_next', 'a stays live');
  f.publish('b_session', 'b is disconnected');
  assert.deepEqual(
    f.frames.filter((frame) => frame.kind === 'session-state').map((frame) => frame.sessionId),
    ['a_next']
  );
});

test('unsubscribing one desktop retains shared conversations until their last observer leaves', async (t) => {
  const f = fixture(t);
  const a = { clientToken: 'desktop-a' };
  const b = { clientToken: 'desktop-b' };
  const service = await f.open('desktop_a', a);
  await f.show(service.desktopId, ['shared_session'], 1, a);
  await f.open('desktop_b', b);
  await f.show(service.desktopId, ['shared_session'], 1, b);
  await f.registry.unsubscribe({ desktopId: service.desktopId }, a);
  assert.deepEqual(f.registrations.at(-1), ['shared_session']);
  f.frames.length = 0;
  f.publish('shared_session', 'still observed');
  assert.equal(f.frames.at(-1)?.sessionId, 'shared_session');
  await f.registry.unsubscribe({ desktopId: service.desktopId }, b);
  assert.deepEqual(f.registrations.at(-1), []);
  f.frames.length = 0;
  f.publish('shared_session', 'no observers');
  assert.deepEqual(f.frames, []);
});
