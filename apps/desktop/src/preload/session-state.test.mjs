import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { DESKTOP_IPC } from '../shared/contract.ts';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

function fixture() {
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (...args) => sent.push(args);
  let api;
  runInNewContext(bundle.outputFiles[0].text, {
    process: { argv: [], env: {} },
    window: { addEventListener() {} },
    require: (specifier) => {
      assert.equal(specifier, 'electron');
      return {
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        sharedTexture: { setSharedTextureReceiver() {} },
      };
    },
  });
  return {
    api,
    ipc,
    sent,
    publish: (sessionId, wire, metadata = {}) =>
      ipc.emit(DESKTOP_IPC.sessionState, {}, { sessionId, wire, ...metadata }),
  };
}

test('preload retains independent session decoders and forwards snapshot metadata without exposing IPC events', () => {
  const f = fixture();
  const updates = [];
  const stop = f.api.subscribeSessionState((...args) => {
    assert.equal(args.length, 1);
    updates.push(args[0]);
  });
  const alphaItems = [{ id: 'alpha-item', text: 'alpha' }];
  const betaItems = [{ id: 'beta-item', text: 'beta' }];
  f.publish('alpha', { items: alphaItems, __itemsRevision: 1 });
  f.publish('beta', { items: betaItems, __itemsRevision: 7 });
  f.publish(
    'alpha',
    { __itemsPatch: { base: 1, revision: 2, prefix: 1, append: [] } },
    { readTraceId: 'trace-alpha', contentRevision: 0 }
  );
  f.publish('beta', { __itemsPatch: { base: 7, revision: 8, prefix: 1, append: [] } });
  assert.equal(updates.length, 4);
  assert.equal(updates[2].sessionId, 'alpha');
  assert.equal(updates[2].snapshot.items, alphaItems);
  assert.equal(updates[2].readTraceId, 'trace-alpha');
  assert.equal(updates[2].contentRevision, 0);
  assert.equal(updates[3].sessionId, 'beta');
  assert.equal(updates[3].snapshot.items, betaItems);
  assert.equal(Object.hasOwn(updates[3], 'readTraceId'), false);
  assert.equal(Object.hasOwn(updates[3], 'contentRevision'), false);
  assert.equal(f.sent.length, 0);
  stop();
  assert.equal(f.ipc.listenerCount(DESKTOP_IPC.sessionState), 0);
});

test('preload resets only the failed session and tolerates resync delivery failure until a full snapshot arrives', () => {
  const f = fixture();
  const updates = [];
  const stop = f.api.subscribeSessionState((update) => updates.push(update));
  f.publish('alpha', { items: [], __itemsRevision: 1 });
  f.publish('beta', { items: [], __itemsRevision: 1 });
  f.ipc.send = (...args) => {
    f.sent.push(args);
    throw new Error('IPC is closing');
  };
  f.publish('alpha', { __itemsPatch: { base: 99, revision: 2, prefix: 0, append: [] } });
  f.publish('alpha', { __itemsPatch: { base: 1, revision: 2, prefix: 0, append: [] } });
  assert.equal(updates.length, 2);
  assert.deepEqual(f.sent, [
    [DESKTOP_IPC.sessionStateResync, 'alpha'],
    [DESKTOP_IPC.sessionStateResync, 'alpha'],
  ]);
  f.publish('beta', { __itemsPatch: { base: 1, revision: 2, prefix: 0, append: [] } });
  f.publish('alpha', { items: [], __itemsRevision: 10 });
  f.publish('alpha', { __itemsPatch: { base: 10, revision: 11, prefix: 0, append: [] } });
  assert.equal(updates.length, 5);
  assert.equal(updates[2].sessionId, 'beta');
  assert.equal(updates[4].sessionId, 'alpha');
  assert.equal(f.sent.length, 2);
  stop();
});

test('preload drops ended sessions and unsubscribing does not disturb another subscription', () => {
  const f = fixture();
  const first = [];
  const second = [];
  const stopFirst = f.api.subscribeSessionState((update) => first.push(update));
  const stopSecond = f.api.subscribeSessionState((update) => second.push(update));
  f.publish('alpha', { items: [], __itemsRevision: 1 });
  f.publish('alpha', null);
  assert.equal(first[1].snapshot, null);
  assert.equal(second[1].snapshot, null);
  f.publish('alpha', { __itemsPatch: { base: 1, revision: 2, prefix: 0, append: [] } });
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(f.sent, [
    [DESKTOP_IPC.sessionStateResync, 'alpha'],
    [DESKTOP_IPC.sessionStateResync, 'alpha'],
  ]);
  stopFirst();
  assert.equal(f.ipc.listenerCount(DESKTOP_IPC.sessionState), 1);
  f.publish('alpha', { items: [], __itemsRevision: 3 });
  f.publish('alpha', { __itemsPatch: { base: 3, revision: 4, prefix: 0, append: [] } });
  assert.equal(first.length, 2);
  assert.equal(second.length, 4);
  assert.equal(f.sent.length, 2);
  stopSecond();
  assert.equal(f.ipc.listenerCount(DESKTOP_IPC.sessionState), 0);
});
