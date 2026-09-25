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

test('preload reassembles state patches and resyncs once the patch chain breaks', () => {
  const f = fixture();
  const snapshots = [];
  const stop = f.api.subscribeState((snapshot) => snapshots.push(snapshot));
  const emit = (wire) => f.ipc.emit(DESKTOP_IPC.state, {}, wire);
  // The bridge runs in its own VM realm; compare its objects by value.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const items = [{ id: 'a', text: 'one' }];
  emit({ items, __itemsRevision: 1, __statePatch: {}, title: 'T', streamingTail: { id: 'tail', text: 'he' } });
  assert.equal(snapshots[0].items, items);
  assert.equal(snapshots[0].title, 'T');
  assert.equal(Object.hasOwn(snapshots[0], '__itemsRevision'), false);
  assert.equal(Object.hasOwn(snapshots[0], '__statePatch'), false);
  assert.deepEqual(snapshots[0].streamingTail, { id: 'tail', text: 'he' });

  emit({
    __itemsPatch: { base: 1, revision: 2, prefix: 1, append: [] },
    __streamingTailPatch: { tail: { id: 'tail' }, prefix: 2, append: 'llo' },
    title: 'T',
  });
  assert.equal(snapshots[1].items, items, 'an empty items patch keeps the array identity');
  assert.deepEqual(plain(snapshots[1].streamingTail), { id: 'tail', text: 'hello' });
  assert.equal(snapshots[1].title, 'T');
  assert.equal(Object.hasOwn(snapshots[1], '__itemsPatch'), false);
  assert.equal(Object.hasOwn(snapshots[1], '__streamingTailPatch'), false);

  emit({
    __itemsPatch: { base: 2, revision: 3, prefix: 1, append: [{ id: 'b' }] },
    __statePatch: { base: 2, revision: 3, removed: ['title'], changed: { busy: true } },
  });
  assert.deepEqual(plain(snapshots[2].items), [{ id: 'a', text: 'one' }, { id: 'b' }]);
  assert.equal(Object.hasOwn(snapshots[2], 'title'), false);
  assert.equal(snapshots[2].busy, true);
  assert.deepEqual(plain(snapshots[2].streamingTail), { id: 'tail', text: 'hello' });
  assert.equal(f.sent.length, 0);

  emit({
    __itemsPatch: { base: 3, revision: 4, prefix: 2, append: [] },
    __streamingTailPatch: { tail: { id: 'other' }, prefix: 0, append: 'x' },
  });
  assert.equal(snapshots.length, 3);
  assert.deepEqual(f.sent, [[DESKTOP_IPC.stateResync]]);
  emit({ __itemsPatch: { base: 3, revision: 4, prefix: 2, append: [] } });
  assert.equal(snapshots.length, 3);
  assert.equal(f.sent.length, 2);

  emit({ items: [], __itemsRevision: 9 });
  emit({ __itemsPatch: { base: 9, revision: 10, prefix: 0, append: [] }, streamingTail: null });
  assert.equal(snapshots.length, 5);
  assert.equal(snapshots[4].streamingTail, null);
  emit(null);
  assert.equal(snapshots[5], null);
  stop();
  assert.equal(f.ipc.listenerCount(DESKTOP_IPC.state), 0);
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
