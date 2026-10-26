import assert from 'node:assert/strict';
import test from 'node:test';
import { startRestoredSessionReads } from './boot-session-read.ts';
import { requestSessionRead } from './session-read-request.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { createPaneLeaf } from './pane-layout.ts';

const PANE_LAYOUT_KEY = 'mixdog.desktop.pane-layout.v1';

function storedLayout(selection) {
  const leaf = createPaneLeaf(selection, 'leaf_a');
  return JSON.stringify({ layout: leaf, focusedLeafId: leaf.id });
}

function fixture(t, { layout = null, file = null, remote = false, prefetchSession }) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map(layout === null ? [] : [[PANE_LAYOUT_KEY, layout]]);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout,
      clearTimeout,
      localStorage: { getItem: (key) => values.get(key) ?? null },
      ...(remote ? { mixdogRemoteServer: 'https://relay.example' } : {}),
      mixdogDesktop: { prefetchSession, readPaneLayoutFile: () => file },
    },
  });
  defaultSessionLaneStore.clear();
  t.after(() => {
    defaultSessionLaneStore.clear();
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete globalThis.window;
  });
}

test('boot starts exactly one read for the restored session and the pane read joins it', async (t) => {
  const calls = [];
  const pending = Promise.withResolvers();
  fixture(t, {
    layout: storedLayout({ kind: 'session', id: 'restored' }),
    prefetchSession: (id) => {
      calls.push(id);
      return pending.promise;
    },
  });
  startRestoredSessionReads();
  assert.deepEqual(calls, ['restored'], 'started synchronously at boot, before any pane exists');
  // The pane mounts later and asks for the same session.
  const paneRead = requestSessionRead('restored');
  assert.deepEqual(calls, ['restored'], 'the pane read reuses the in-flight request');
  pending.resolve(true);
  assert.equal(await paneRead, true);
  assert.deepEqual(calls, ['restored']);
});

test('the profile-file layout restores when localStorage has none', (t) => {
  const calls = [];
  fixture(t, {
    file: storedLayout({ kind: 'session', id: 'from_file' }),
    prefetchSession: async (id) => calls.push(id) > 0,
  });
  startRestoredSessionReads();
  assert.deepEqual(calls, ['from_file']);
});

for (const [name, layout] of [
  ['nothing stored', null],
  ['the stored pane shows New task', storedLayout({ kind: 'new' })],
  ['a malformed layout', '{not json'],
]) {
  test(`no read without a restored session: ${name}`, (t) => {
    const calls = [];
    fixture(t, { layout, prefetchSession: async (id) => calls.push(id) > 0 });
    startRestoredSessionReads();
    assert.deepEqual(calls, []);
  });
}

test('a remote renderer leaves the read to its view sync', (t) => {
  const calls = [];
  fixture(t, {
    layout: storedLayout({ kind: 'session', id: 'restored' }),
    remote: true,
    prefetchSession: async (id) => calls.push(id) > 0,
  });
  startRestoredSessionReads();
  assert.deepEqual(calls, []);
});

test('host not ready at boot: the pane that joined the failed boot read still loads', async (t) => {
  const calls = [];
  fixture(t, {
    layout: storedLayout({ kind: 'session', id: 'early' }),
    // The host answers only from the fourth call on: the boot read's three
    // attempts all hit a host that is not ready.
    prefetchSession: async (id) => {
      calls.push(id);
      if (calls.length <= 3) throw new Error('Mixdog service startup timed out.');
      return true;
    },
  });
  startRestoredSessionReads();
  const paneRead = requestSessionRead('early');
  assert.equal(calls.length, 1, 'the pane joined the boot read');
  assert.equal(await paneRead, true, 'the boot read failed; the pane read its own');
  assert.equal(calls.length, 4, 'three failed boot attempts, then one fresh pane read');
});

test('a boot read that fails with nobody waiting leaves a later pane read a fresh request', async (t) => {
  const calls = [];
  fixture(t, {
    layout: storedLayout({ kind: 'session', id: 'flaky' }),
    prefetchSession: async (id) => {
      calls.push(id);
      return calls.length > 3;
    },
  });
  startRestoredSessionReads();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(calls.length, 3);
  assert.equal(await requestSessionRead('flaky'), true);
  assert.equal(calls.length, 4);
});

test('a pane that fails its own read is not retried again', async (t) => {
  const calls = [];
  fixture(t, { prefetchSession: async (id) => calls.push(id) < 0 });
  assert.equal(await requestSessionRead('plain'), false);
  assert.equal(calls.length, 3);
});
