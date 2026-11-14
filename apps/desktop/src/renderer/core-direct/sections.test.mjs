// createSectionsApi over a RendererConnection with a fake client: snapshot, store-change pushes, the closed method guard,
// scoped feeds, file watches, ports, and the sign-in feed, as the window IPC served them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRendererConnection } from './renderer-connection.ts';
import { createDirectContext } from './context.ts';
import { createSectionsApi } from './sections.ts';
import { createSectionStore } from '../section-store.ts';

function fakeClient() {
  const calls = [];
  const listeners = new Set();
  const storeListeners = new Set();
  const entries = new Map();
  return {
    calls,
    status: { state: 'ready' },
    store: {
      sections: (name) => [...entries.values()].filter((e) => e.section === name),
      section: (section, key = null) => entries.get(`${section}\0${key ?? ''}`),
      appFeed: () => ({ epoch: 'e1' }),
      subscribe: (l) => (storeListeners.add(l), () => storeListeners.delete(l)),
    },
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
    notify: () => undefined,
    subscribeApp: async () => undefined,
    resumeThread: async () => ({}),
    unsubscribeThread: async () => undefined,
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    close: async () => undefined,
    emit: (event) => listeners.forEach((l) => l(event)),
    put(entry) {
      entries.set(`${entry.section}\0${entry.key ?? ''}`, entry);
      storeListeners.forEach((l) => l({ type: 'section', section: entry.section, key: entry.key }));
    },
  };
}

async function setup() {
  const client = fakeClient();
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const { sections } = createSectionsApi(createDirectContext(connection));
  return { client, connection, sections };
}

test('snapshot_and_store_change_push', async () => {
  const { client, sections } = await setup();
  client.put({ section: 'config', key: null, revision: 1, value: { a: 1 } });
  const snap = await sections.snapshot();
  assert.equal(snap.status, 'ready');
  assert.deepEqual(snap.entries.map((e) => e.section), ['config']);
  const pushes = [];
  sections.subscribe((p) => pushes.push(p));
  client.put({ section: 'config', key: null, revision: 2, value: { a: 2 } });
  const change = pushes.find((p) => p.kind === 'sections');
  assert.equal(change.changes[0].entry.revision, 2);
});

test('section_store_reads_the_clients_changes', async () => {
  const { client, sections } = await setup();
  const store = createSectionStore(sections);
  await store.ready();
  client.put({ section: 'config', key: null, revision: 1, value: 'x' });
  assert.equal(store.get('config')?.value, 'x');
  assert.equal(store.status(), 'ready');
  store.dispose();
});

test('status_event_pushed', async () => {
  const { client, sections } = await setup();
  const pushes = [];
  sections.subscribe((p) => pushes.push(p));
  client.emit({ type: 'status', status: { state: 'closed' } });
  assert.deepEqual(pushes.at(-1), { kind: 'status', status: 'closed' });
});

test('call_closed_list_guard_and_core', async () => {
  const { client, sections } = await setup();
  assert.equal(await sections.core(), true);
  await assert.rejects(() => sections.call('thread/start', {}), /not available to the window/);
  await sections.call('usage/getUsageStats', { a: 1 });
  assert.deepEqual(client.calls.at(-1), { method: 'usage/getUsageStats', params: { a: 1 } });
  await assert.rejects(() => sections.call('feed/subscribe', { feedId: 'other:1' }), /not available to the window/);
});

test('scoped_feed_sections_reach_the_window', async () => {
  const { client, sections } = await setup();
  const pushes = [];
  sections.subscribe((p) => pushes.push(p));
  assert.deepEqual(await sections.call('feed/subscribe', { feedId: 'media:j1' }), { absent: false });
  client.emit({
    type: 'notification',
    notification: {
      method: 'feed/snapshot',
      feed: { id: 'media:j1' },
      params: { state: { sections: [{ section: 'mediaJobs', key: 'j1', revision: 1, value: { s: 1 } }] } },
    },
  });
  assert.equal(pushes.find((p) => p.kind === 'sections')?.changes[0].entry.value.s, 1);
  await sections.call('feed/unsubscribe', { feedId: 'media:j1' });
  const last = pushes.filter((p) => p.kind === 'sections').at(-1);
  assert.equal(last.changes[0].entry, null);
  assert.equal(client.calls.at(-1).method, 'feed/unsubscribe');
});

test('fs_watch_and_changed', async () => {
  const { client, sections } = await setup();
  const seen = [];
  sections.subscribeFsChanged((c) => seen.push(c));
  await sections.call('fs/watch', { watchId: 'w1', path: '/x' });
  assert.deepEqual(client.calls.at(-1), { method: 'fs/watch', params: { watchId: 'w1', path: '/x' } });
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: 'w1', changedPaths: ['/x/a'] } } });
  assert.deepEqual(seen, [{ watchId: 'w1', changedPaths: ['/x/a'] }]);
  await sections.call('fs/unwatch', { watchId: 'w1' });
  assert.equal(client.calls.at(-1).method, 'fs/unwatch');
});

test('ports_view_subscribes_once', async () => {
  const { client, sections } = await setup();
  await sections.call('system/ports/subscribe', {});
  await sections.call('system/ports/subscribe', {});
  assert.equal(client.calls.filter((c) => c.method === 'system/ports/subscribe').length, 1);
  await sections.call('system/ports/unsubscribe', {});
  assert.equal(client.calls.at(-1).method, 'system/ports/unsubscribe');
});

test('login_feed_updates_and_unknown_flow_is_lost', async () => {
  const { client, sections } = await setup();
  const updates = [];
  sections.subscribeLoginUpdated((u) => updates.push(u));
  assert.deepEqual(await sections.loginFeed('nope'), { state: null, lost: true });
  client.emit({ type: 'notification', notification: { method: 'login/updated', params: { flowId: 'f1', state: { state: 'pending' } } } });
  assert.deepEqual(updates, [{ flowId: 'f1', state: { state: 'pending' } }]);
});

test('replaced_connection_swaps_the_whole_store', async () => {
  const first = fakeClient();
  first.put({ section: 'config', key: null, revision: 5, value: 'old' });
  first.put({ section: 'projects', key: null, revision: 1, value: 'gone' });
  const clients = [first];
  const connection = createRendererConnection({ open: async () => clients.shift() });
  await connection.start();
  const store = createSectionStore(createSectionsApi(createDirectContext(connection)).sections);
  await store.ready();
  assert.equal(store.get('projects')?.value, 'gone');
  const next = fakeClient();
  next.put({ section: 'config', key: null, revision: 1, value: 'new' });
  clients.push(next);
  await connection.reopen();
  assert.equal(store.get('config')?.value, 'new', 'a restarted core numbers its revisions again');
  assert.equal(store.get('projects'), undefined, 'what the new store lacks is dropped');
  store.dispose();
});
