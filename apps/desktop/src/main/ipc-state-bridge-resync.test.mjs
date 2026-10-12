import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';

function fixture() {
  const handlers = new Map();
  const deliveries = [];
  const resyncRequests = [];
  const decoder = createSnapshotDeltaDecoder();
  const mainFrame = {};
  const webContents = {
    isDestroyed: () => false,
    mainFrame,
    send(channel, value) {
      if (channel !== DESKTOP_IPC.sessionState) return;
      const received = structuredClone(value);
      deliveries.push({ ...received, snapshot: decoder.decode(received.wire).snapshot });
    },
  };
  let publish = () => {};
  const ipcMain = new EventEmitter();
  const bridge = new DesktopStateBridge({
    window: { isDestroyed: () => false, webContents },
    host: {
      subscribe: () => () => {},
      subscribeSessionStates(listener) {
        publish = listener;
        return () => {};
      },
      getSnapshot: () => ({}),
      setVisibleSessions: async () => true,
      prefetchSession: async () => true,
      requestSessionStateResync: (id) => resyncRequests.push(id),
    },
    ipcMain,
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  const frame = (sessionId, text = 'loaded', extra = {}) => ({
    sessionId,
    frameSource: 'read',
    snapshot: { sessionId, items: [{ id: 'answer', kind: 'assistant', text }], queued: [] },
    ...extra,
  });
  const resync = (sessionId, sender = webContents) =>
    ipcMain.emit(DESKTOP_IPC.sessionStateResync, { sender, senderFrame: mainFrame }, sessionId);
  return { bridge, handlers, deliveries, resyncRequests, publish: (u) => publish(u), frame, resync };
}

test('resync without a main cache asks the service and its full frame reaches the renderer', (t) => {
  const f = fixture();
  t.after(() => f.bridge.dispose());
  f.resync('lead');
  f.resync('lead');
  assert.deepEqual(f.resyncRequests, ['lead'], 'repeated requests coalesce');
  f.publish(f.frame('lead'));
  assert.equal(f.deliveries.length, 1, 'recovery frame passes the visibility filter');
  assert.equal(f.deliveries[0].snapshot.items[0].text, 'loaded');
});

test('resync is ignored for foreign senders and invalid session ids', (t) => {
  const f = fixture();
  t.after(() => f.bridge.dispose());
  f.resync('lead', {});
  f.resync('');
  assert.deepEqual(f.resyncRequests, []);
});

test('recovery resets the main encoder so an identical frame is not dropped', (t) => {
  const f = fixture();
  t.after(() => f.bridge.dispose());
  f.handlers.get(DESKTOP_IPC.setVisibleSessions)({}, ['lead']);
  const same = f.frame('lead');
  f.publish(same);
  f.publish(same);
  assert.equal(f.deliveries.length, 1, 'ordinary unchanged frame is suppressed');
  f.resync('lead');
  assert.deepEqual(f.resyncRequests, [], 'main cache present: no service request');
  assert.equal(f.deliveries.length, 2, 'replayed from main cache');
});

test('a service recovery frame is delivered even when main encoder holds an identical baseline', (t) => {
  const f = fixture();
  t.after(() => f.bridge.dispose());
  f.handlers.get(DESKTOP_IPC.setVisibleSessions)({}, ['lead']);
  f.publish(f.frame('lead'));
  // Lose main's cache but keep the encoder baseline.
  f.bridge.latestSessionStates.delete('lead');
  f.resync('lead');
  assert.deepEqual(f.resyncRequests, ['lead']);
  f.publish(f.frame('lead'));
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[1].snapshot.items[0].text, 'loaded');
});
