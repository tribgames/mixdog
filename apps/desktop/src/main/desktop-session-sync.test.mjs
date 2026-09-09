import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { createDesktopService } from './desktop-service.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

for (const boundary of ['service', 'ipc']) {
  test(`${boundary} preserves cancel, resubmit and recovery without sending unchanged session frames`, async () => {
    const f = await viewSyncHost({ runTurns: true });
    const frames = [];
    const faults = [];
    let decoder = createSnapshotDeltaDecoder();
    let snapshot, dropNext = false, service, bridge;
    const receive = (message) => {
      try {
        const transferred = boundary === 'ipc'
          ? structuredClone(message) : JSON.parse(JSON.stringify(message));
        if (transferred.kind !== 'session-state' || transferred.sessionId !== 'lead') return;
        if (dropNext) { dropNext = false; return; }
        const decoded = decoder.decode(transferred.wire);
        assert.equal(decoded.ok, true);
        assert.ok(Array.isArray(decoded.snapshot?.items), 'every publication has a real transcript');
        snapshot = decoded.snapshot;
        frames.push(transferred);
      } catch (error) {
        // The real host isolates listener faults, so retain them for the test
        // rather than allowing a serialization failure to disappear there.
        faults.push(error);
      }
    };
    try {
      f.put('lead', 'previous answer');
      let invoke, recover;
      if (boundary === 'service') {
        service = await createDesktopService({
          options: f.options,
          runtime: { ...f.runtime, loadConfig: async () => ({}) },
          emit: receive,
        });
        invoke = (method, args) => service.invoke(method, args);
        recover = () => service.control({ kind: 'session-state-resync', sessionId: 'lead' });
      } else {
        const handlers = new Map();
        const ipcMain = new EventEmitter();
        const webContents = {
          mainFrame: {}, isDestroyed: () => false,
          send(channel, value) {
            if (channel === DESKTOP_IPC.sessionState) receive({ kind: 'session-state', ...value });
          },
        };
        bridge = new DesktopStateBridge({
          window: { isDestroyed: () => false, webContents },
          host: f.host,
          ipcMain,
          handle: (channel, handler) => handlers.set(channel, handler),
        });
        invoke = (method, args) => method === 'setVisibleSessions'
          ? handlers.get(DESKTOP_IPC.setVisibleSessions)({}, ...args)
          : f.host[method](...args);
        recover = () => ipcMain.emit(DESKTOP_IPC.sessionStateResync, {
          sender: webContents, senderFrame: webContents.mainFrame,
        }, 'lead');
      }
      await invoke('setVisibleSessions', [['lead']]);
      assert.equal(snapshot.items[0].text, 'previous answer');
      for (let cycle = 0; cycle < 3; cycle++) {
        const before = snapshot.items;
        const frameCount = frames.length;
        f.putSnapshot('lead', { ...f.records.get('lead').snapshot });
        assert.equal(frames.length, frameCount, 'unchanged content must not cross the transport');
        const cancelledId = `cancel-${cycle}`;
        assert.equal(await invoke('submitToSession', ['lead', 'cancel this', { id: cancelledId }]), true);
        assert.equal(snapshot.items.at(-1).id, cancelledId);
        const aborted = await invoke('abortSession', ['lead']);
        assert.equal(aborted.aborted, true);
        assert.deepEqual(snapshot.items, before);
        assert.equal(snapshot.busy, false);
        const nextId = `next-${cycle}`;
        assert.equal(await invoke('submitToSession', ['lead', 'continue', { id: nextId }]), true);
        assert.equal(snapshot.items.at(-1).id, nextId);
        const current = f.records.get('lead').snapshot;
        const finished = {
          ...current, busy: false,
          items: [...current.items, { id: `answer-${cycle}`, kind: 'assistant', text: `finished ${cycle}` }],
        };
        dropNext = true;
        f.putSnapshot('lead', finished);
        assert.equal(dropNext, false);
        assert.notEqual(snapshot.items.at(-1).text, `finished ${cycle}`);
        decoder = createSnapshotDeltaDecoder();
        await recover();
        assert.deepEqual(snapshot.items, finished.items);
        assert.equal(snapshot.busy, false);
        assert.deepEqual(faults, []);
      }
    } finally {
      bridge?.dispose();
      await service?.dispose();
      await f.close();
    }
  });
}
