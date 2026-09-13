import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { setTranscriptReadDiagnosticSink } from '../shared/transcript-read-diagnostics.ts';
import { createDesktopService } from './desktop-service.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

test('one read id crosses the service, main decoder and renderer IPC while suppressed reads stay observable', async () => {
  const f = await viewSyncHost();
  const diagnostics = [];
  const restore = setTranscriptReadDiagnosticSink(entry => diagnostics.push(entry));
  let transport, service, client, bridge;
  const deliveries = [];
  const decoder = createSnapshotDeltaDecoder();
  try {
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({}) },
      emit: message => transport?.emit('message', structuredClone(message)),
    });
    transport = new class extends EventEmitter {
      postMessage(message) {
        if (message.kind === 'init') {
          queueMicrotask(() => this.emit('message', { kind: 'ready' }));
        } else if (message.kind === 'request') {
          void service.invoke(message.method, message.args).then(
            value => this.emit('message', { kind: 'response', id: message.id, ok: true, value }),
            error => this.emit('message', {
              kind: 'response', id: message.id, ok: false,
              error: { name: error.name, message: error.message },
            }),
          );
        }
      }
      async close() {}
    }();
    client = new DesktopServiceClient({
      connect: () => transport, sessionOptions: () => f.options,
    });
    await client.start();
    const handlers = new Map();
    bridge = new DesktopStateBridge({
      window: { isDestroyed: () => false, webContents: {
        isDestroyed: () => false, mainFrame: {},
        send(channel, value) {
          if (channel !== DESKTOP_IPC.sessionState) return;
          const received = structuredClone(value);
          const decoded = decoder.decode(received.wire);
          assert.equal(decoded.ok, true);
          deliveries.push({ ...received, snapshot: decoded.snapshot });
        },
      } },
      host: client, ipcMain: new EventEmitter(),
      handle: (channel, handler) => handlers.set(channel, handler),
    });
    await handlers.get(DESKTOP_IPC.setVisibleSessions)({}, ['lead']);
    // A cold durable record appears without a preceding live publication.
    const snapshot = {
      sessionId: 'lead', items: [{ id: 'answer', kind: 'assistant', text: 'private conversation' }], queued: [],
    };
    f.records.set('lead', { id: 'lead', revision: 1, snapshot });
    assert.equal(await client.prefetchSession('lead', undefined, 'read-flow-1'), true);
    const received = deliveries.at(-1);
    assert.equal(received.readTraceId, 'read-flow-1');
    assert.equal(received.snapshot.items[0].text, 'private conversation');
    assert.deepEqual(diagnostics.filter(r => r.traceId === 'read-flow-1').map(r => r.stage), [
      'host-start', 'host-read-start', 'host-read-result', 'host-projected',
      'service-send', 'main-received', 'ipc-send', 'host-published',
    ]);
    const count = deliveries.length;
    assert.equal(await client.prefetchSession('lead', undefined, 'read-flow-2'), true);
    assert.equal(deliveries.length, count, 'instrumentation must not force unchanged frames');
    assert.ok(diagnostics.some(r => r.traceId === 'read-flow-2' && r.stage === 'service-unchanged'));
    f.records.set('hidden', {
      id: 'hidden', revision: 1, snapshot: { ...snapshot, sessionId: 'hidden' },
    });
    assert.equal(await client.prefetchSession('hidden', undefined, 'read-hidden'), true);
    assert.ok(diagnostics.some(r => r.traceId === 'read-hidden' && r.stage === 'service-hidden'));
    assert.equal(JSON.stringify(diagnostics).includes('private conversation'), false);
  } finally {
    bridge?.dispose();
    await client?.dispose();
    await service?.dispose();
    restore();
    await f.close();
  }
});
