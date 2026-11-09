// The phone's thread list through a daemon restart, replayed against Node's recording (remote-protocol-chat-roster.recorded.json,
// recorded by remote-protocol-chat-roster.record.mjs from the exact b6f10295a export): what the phone's catalog is told, step by step,
// when the same rows arrive as `thread/list` pages and app-feed edges. Plus: a wired chat call's requests carry that call's claim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createChatAdapter, createRosterFeed } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { normalizedProviderModels } from '../main/desktop-support.ts';
import { remoteToolOutput } from '../main/remote-transcript.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';

// The router's call deadline reads the page's timers (remote-shim-call-watch.ts); a Node test has no window.
globalThis.window ??= globalThis;

const recorded = JSON.parse(readFileSync(new URL('./remote-protocol-chat-roster.recorded.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// The core's row is the stored row with `desktopSession` flattened (thread-rows.ts).
const coreRow = ({ desktopSession, ...rest }) => ({ ...rest, classification: desktopSession.classification, projectPath: desktopSession.projectPath });

test('the recording is an exact Node b6f10295a manifest', () => {
  assert.equal(recorded.manifest.exact, true);
  assert.equal(recorded.manifest.commit, 'b6f10295a2f698afc85332467192de28500bd146');
  assert.ok(recorded.manifest.filesCompared > 9000);
});

function rig(pageSize = 2) {
  let listing = [];
  let gate = null;
  const listeners = new Set();
  const stores = new Set();
  const requests = [];
  const client = {
    call: async (method, params) => {
      requests.push({ method, params });
      assert.equal(method, 'thread/list');
      if (gate) await gate;
      const rows = listing.map(coreRow);
      const from = params.cursor ? Number(params.cursor) : 0;
      const data = rows.slice(from, from + pageSize);
      return { data, ...(from + pageSize < rows.length ? { nextCursor: String(from + pageSize) } : {}) };
    },
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    store: { subscribe: (listener) => (stores.add(listener), () => stores.delete(listener)) },
  };
  const published = [];
  const feed = createRosterFeed({ summaries: (rows) => summariesOfThreadRows(rows), publish: (rows) => published.push(plain(rows)) });
  feed.attach(client);
  return {
    feed,
    client,
    published,
    requests,
    setListing: (rows) => (listing = rows),
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
    edge: (method, params) => listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
    store: (change) => stores.forEach((l) => l(change)),
  };
}

/** The edges that take `before` to `after`, as the core announces them. */
function edgesOf(before, after) {
  const was = new Map(before.map((row) => [row.id, JSON.stringify(row)]));
  return [
    ...after.filter((row) => was.get(row.id) !== JSON.stringify(row)).map((row) => (was.has(row.id) ? ['thread/summary/updated', { thread: coreRow(row) }] : ['thread/started', { thread: coreRow(row) }])),
    ...before.filter((row) => !after.some((r) => r.id === row.id)).map((row) => ['thread/deleted', { threadId: row.id }]),
  ];
}

const step = (name) => recorded.steps.find((s) => s.name === name);

test('attach: the whole list is read, in pages, and published once as Node\'s baseline was', async () => {
  const s = step('attach-baseline');
  const r = rig();
  r.setListing(s.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  assert.deepEqual(r.published, s.published);
  assert.ok(r.requests.length > 1 && r.requests.every((q) => q.params.limit === 1000), 'every page follows the cursor');
  assert.deepEqual(r.requests.slice(1).map((q) => q.params.cursor), ['2', '4'].slice(0, r.requests.length - 1));
});

test('a pushed edge changes the list as Node\'s live roster push did', async () => {
  const [attach, live] = ['attach-baseline', 'live-push'].map(step);
  const r = rig();
  r.setListing(attach.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  r.published.length = 0;
  for (const [method, params] of edgesOf(attach.coreRows, live.coreRows)) r.edge(method, params);
  assert.deepEqual(r.published, live.published);
});

test('an edge that changes nothing publishes nothing (Node skipped an unchanged roster)', async () => {
  const attach = step('attach-baseline');
  const r = rig();
  r.setListing(attach.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  r.published.length = 0;
  r.edge('thread/summary/updated', { thread: coreRow(attach.coreRows[1]) });
  assert.deepEqual(r.published, []);
});

test('restart: the app feed coming back re-reads the whole list, and rows gone while the core was away are gone', async () => {
  const [, live, same, changed] = ['attach-baseline', 'live-push', 'restart-same-roster', 'restart-roster-changed'].map(step);
  const r = rig();
  r.setListing(live.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  r.published.length = 0;
  // The core restarts with the same rows: no edge is republished, the list is read again.
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await tick();
  assert.deepEqual(r.published, same.published);
  // Restarts again after rows changed while it was away: no edge announces them.
  r.published.length = 0;
  r.setListing(changed.coreRows);
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await tick();
  assert.deepEqual(r.published, changed.published);
  assert.equal(changed.published[0].some((row) => row.id === 'sess_3'), false);
});

test('a change between re-subscribing and the list outranks the listing, as Node\'s pushed roster did', async () => {
  const [changed, between, after] = ['restart-roster-changed', 'change-between-subscribe-and-list', 'live-push-after-restart'].map(step);
  const r = rig();
  r.setListing(changed.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  r.published.length = 0;
  const release = r.hold();
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await tick();
  // The listing is still being read (it will answer with the older rows) when the core announces the change.
  for (const [method, params] of edgesOf(changed.coreRows, between.coreRows)) r.edge(method, params);
  release();
  await tick();
  assert.deepEqual(r.published, between.published);
  r.published.length = 0;
  for (const [method, params] of edgesOf(between.coreRows, after.coreRows)) r.edge(method, params);
  assert.deepEqual(r.published, after.published);
});

test('a lost app feed is read again at the next snapshot', async () => {
  const attach = step('attach-baseline');
  const r = rig();
  r.setListing(attach.coreRows);
  r.store({ type: 'appSnapshot' });
  await tick();
  r.store({ type: 'subscription', feedId: 'app', state: 'lost' });
  r.published.length = 0;
  r.store({ type: 'appSnapshot' });
  await tick();
  assert.deepEqual(r.published, attach.published);
});

// ── PH-1: a wired chat call's requests carry that call's transmission claim ─────────────────────────────────────────────────────────
test('a chat call wired through the router writes every request with its own claim', async () => {
  const written = [];
  const client = {
    call: async (method, params, options) => {
      written.push({ method, params, sent: options?.sent });
      if (method === 'thread/list') return { data: [] };
      return {};
    },
    resumeThread: async (threadId, window, options) => (written.push({ method: 'thread/resume', sent: options?.sent }), {}),
    unsubscribeThread: async (threadId, options) => (written.push({ method: 'thread/unsubscribe', sent: options?.sent }), undefined),
    server: { connection: { device: 'Phone' } },
  };
  const made = [];
  const adapter = createChatAdapter({
    sharedFor: (scoped) => {
      made.push(scoped);
      const protocol = {
        call: (method, params) => scoped.call(method, params),
        snapshot: () => ({ entries: [] }),
        noteUserInput() {},
        respond() {},
        pendingServerRequests: () => [],
      };
      return { routeService, lane: createCapabilityLane({ protocol }), coreErrorForWindow, normalizedProviderModels, sessionStateOf: () => undefined, remoteToolOutput };
    },
    roster: { summaries: (rows) => summariesOfThreadRows(rows) },
  });
  const host = { ctx: { sessionsCatalog: { publish() {} } }, client: () => client, declareLane() {} };
  const router = createProtocolRouter([adapter], { host, started: async () => undefined, synced: async () => undefined, probe() {}, silentSince: () => false });

  await router.call('markSessionRead', ['sess_a', 3, true]);
  await router.call('renameSession', ['sess_a', 'New name']);
  await router.call('listSessions', []);
  await router.call('deleteSession', ['sess_a']).catch(() => undefined);

  assert.ok(written.length >= 4);
  for (const request of written) assert.equal(typeof request.sent, 'function', `${request.method} carries its call's claim`);
  assert.equal(new Set(written.map((w) => w.sent)).size >= 4, true, 'each call has a claim of its own');
  assert.equal(made.length >= 3, true, 'the adapter is built per call from the scoped client, not once');
  assert.ok(made.every((c) => c !== client), 'what the adapter was built from is the call\'s scoped client');
});
