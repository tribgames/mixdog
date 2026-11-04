import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createSessionProxyFactory } from './session-proxy.mjs';

// In-memory daemon: a session table with revisions, one transport per
// attachSession() call, and a hook to fail the next call once (transport
// loss) so the proxy's re-attach + recover path is exercised.
function fakeDaemon() {
  const calls = [];
  const sessions = new Map();
  const attachments = [];
  let nextId = 1;
  let failNext = null;
  // Every call of one route refused before dispatch, as a fenced daemon answers.
  let refuseAll = null;
  const snapshot = (id) => ({ sessionId: id, revision: sessions.get(id).revision, full: sessions.get(id).full });
  const service = {
    'session.create': (params) => {
      const id = params.sessionId || `s${nextId++}`;
      sessions.set(id, { revision: 1, full: { items: [], title: id } });
      return { ...snapshot(id), reservedOnly: false };
    },
    'session.read': (params) => {
      if (params.action) {
        return { sessionId: params.sessionId, revision: sessions.get(params.sessionId).revision, value: params.args };
      }
      return snapshot(params.sessionId);
    },
    'session.subscribe': (params) => snapshot(params.sessionId),
    'session.unsubscribe': () => ({ ok: true }),
    'session.submit': (params) => {
      const s = sessions.get(params.sessionId);
      s.revision += 1;
      s.full = { ...s.full, items: [...s.full.items, params.prompt] };
      return {
        sessionId: params.sessionId,
        accepted: true,
        revision: s.revision,
        baseRevision: s.revision - 1,
        patch: { itemsAppend: { from: s.full.items.length - 1, values: [params.prompt] } },
      };
    },
    'session.abort': (params) => ({ aborted: true, revision: sessions.get(params.sessionId).revision }),
    'project.list': () => ({ projects: [{ path: 'C:/p' }] }),
  };
  const attachSession = async ({ onFrame }) => {
    const transport = {
      closed: null,
      async call(name, params, options) {
        calls.push({ name, params, callId: options?.callId, transport });
        if (refuseAll?.name === name) throw refuseAll.makeError();
        if (failNext) {
          const error = failNext;
          failNext = null;
          throw error;
        }
        const handler = service[name];
        if (!handler) throw new Error(`unknown route ${name}`);
        return handler(params);
      },
      close(reason) {
        transport.closed = reason;
      },
      pushFrame: (frame) => onFrame(frame),
    };
    attachments.push(transport);
    return transport;
  };
  return {
    calls,
    sessions,
    attachments,
    attachSession,
    failNextCall: (error) => {
      failNext = error;
    },
    refuseEveryCall: (name, makeError) => {
      refuseAll = { name, makeError };
    },
  };
}

async function openView(daemon) {
  const createSession = createSessionProxyFactory({
    attachSession: daemon.attachSession,
    ensureDaemon: async () => ({ port: 1, token: 't' }),
  });
  return createSession({ cwd: 'C:/p', log: () => {} });
}

test('create seeds the projection and frames advance it only at the expected base revision', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  assert.equal(daemon.calls[0].name, 'session.create');
  assert.deepEqual(view.getState(), { items: [], title: 's1' });
  const seen = [];
  view.subscribe(() => seen.push(view.getState()));
  const [transport] = daemon.attachments;
  transport.pushFrame({
    type: 'session-state',
    sessionId: 's1',
    revision: 2,
    baseRevision: 1,
    patch: { set: { title: 'patched' }, itemsAppend: { from: 0, values: ['a'] } },
  });
  assert.deepEqual(view.getState(), { items: ['a'], title: 'patched' });
  // Stale frame: older than the projection, ignored without a resync.
  transport.pushFrame({ type: 'session-state', sessionId: 's1', revision: 1, full: { items: [], title: 'old' } });
  assert.equal(view.getState().title, 'patched');
  // Gap frame: baseRevision does not match → resync through session.read.
  daemon.sessions.get('s1').revision = 5;
  daemon.sessions.get('s1').full = { items: ['a', 'b', 'c'], title: 'resynced' };
  transport.pushFrame({ type: 'session-state', sessionId: 's1', revision: 4, baseRevision: 3, patch: { set: {} } });
  await tick();
  await tick();
  assert.equal(view.getState().title, 'resynced');
  assert.equal(daemon.calls.filter((c) => c.name === 'session.read').length, 1);
  assert.equal(seen.length, 2);
  await view.dispose();
});

test('submit carries the base revision, applies the returned patch and reports acceptance', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  const accepted = await view.submitAsync('hello', { id: 'sub-1' });
  assert.equal(accepted, true);
  const submit = daemon.calls.find((c) => c.name === 'session.submit');
  assert.equal(submit.params.baseRevision, 1);
  assert.equal(submit.params.options.id, 'sub-1');
  assert.equal(submit.callId, 'session-submit:s1:sub-1');
  assert.deepEqual(view.getState().items, ['hello']);
  await view.dispose();
});

test('read actions route through session.read and return the value; project routes return their payloads', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  assert.deepEqual(await view.contextStatus('x', 1), ['x', 1]);
  const read = daemon.calls.find((c) => c.name === 'session.read');
  assert.equal(read.params.action, 'contextStatus');
  assert.equal(read.params.baseRevision, 1);
  assert.deepEqual(await view.listProjects(), [{ path: 'C:/p' }]);
  assert.equal(view.notAnAction, undefined);
  await view.dispose();
});

test('newSession and resume rebind the view to the next session id and release the old one', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  assert.equal(await view.newSession(), true);
  assert.equal(view.getState().title, 's2');
  assert.deepEqual(
    daemon.calls.filter((c) => c.name === 'session.unsubscribe').map((c) => c.params.sessionId),
    ['s1']
  );
  daemon.sessions.set('s9', { revision: 7, full: { items: ['z'], title: 's9' } });
  assert.equal(await view.resume('s9', { fromDisk: true }), true);
  assert.equal(view.getState().title, 's9');
  const subscribe = daemon.calls.find((c) => c.name === 'session.subscribe');
  assert.deepEqual(subscribe.params.open.resumeOptions, { fromDisk: true });
  assert.equal(await view.resume(''), false);
  await view.dispose();
});

test('a lost transport re-attaches, recovers the projection and retries the call once', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  daemon.failNextCall(Object.assign(new Error('socket hang up'), { daemonTransportError: true }));
  daemon.sessions.get('s1').revision = 3;
  daemon.sessions.get('s1').full = { items: ['recovered'], title: 's1' };
  const accepted = await view.submitAsync('after loss', { id: 'sub-2' });
  assert.equal(accepted, true);
  assert.equal(daemon.attachments.length, 2);
  const submits = daemon.calls.filter((c) => c.name === 'session.submit');
  assert.equal(submits.length, 2);
  assert.equal(submits[1].transport, daemon.attachments[1]);
  assert.deepEqual(view.getState().items, ['recovered', 'after loss']);
  await view.dispose();
});

// The one refusal left is a fenced daemon's (daemon-refusal.mjs): answered
// before dispatch, so the call runs exactly once, on the next daemon.
const fenced = () =>
  Object.assign(new Error('daemon is shutting down'), { code: 'EDAEMON_FENCED', daemonTransportError: true });

test('a fenced refusal re-attaches silently and the refused call runs once, on the next daemon', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  daemon.failNextCall(fenced());
  assert.equal(await view.submitAsync('once', { id: 'sub-3' }), true);
  assert.deepEqual(view.getState().items, ['once']);
  assert.equal(daemon.sessions.get('s1').revision, 2, 'dispatched once');
  const submits = daemon.calls.filter((c) => c.name === 'session.submit');
  assert.deepEqual(
    submits.map((c) => [c.transport === daemon.attachments[1], c.callId]),
    [
      [false, 'session-submit:s1:sub-3'],
      [true, 'session-submit:s1:sub-3'],
    ]
  );
  await view.dispose();
});

test('a daemon that keeps refusing is asked a bounded number of times, then the refusal is returned', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  daemon.refuseEveryCall('session.submit', fenced);
  await assert.rejects(view.submitAsync('never', { id: 'sub-4' }), { code: 'EDAEMON_FENCED' });
  assert.equal(daemon.calls.filter((c) => c.name === 'session.submit').length, 4);
  assert.equal(daemon.sessions.get('s1').revision, 1, 'never dispatched');
});

test('dispose unsubscribes the last local view, closes the idle transport and rejects later calls', async () => {
  const daemon = fakeDaemon();
  const view = await openView(daemon);
  await view.dispose('bye');
  assert.equal(view.disposedView, true);
  assert.equal(daemon.calls.at(-1).name, 'session.unsubscribe');
  assert.equal(daemon.attachments[0].closed, 'bye');
  await assert.rejects(() => view.submitAsync('x'), /disposed/);
  assert.equal(view.submit('x'), false);
  assert.deepEqual(await view.abortAsync(), { aborted: false });
});
