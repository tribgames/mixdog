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

// The recording carries each row as the core sends it (`coreRows`: the stored row flattened, the overlays as fields of the row), the core's`n// app-feed events of the step (`edges`, in order) and what Node's phone published for it (`published`, `roster`): the replay feeds the`n// recorded rows and edges and compares whole rows, every field Node's row had.

test('the recording is an exact Node b6f10295a manifest', () => {
  assert.equal(recorded.manifest.exact, true);
  assert.equal(recorded.manifest.commit, 'b6f10295a2f698afc85332467192de28500bd146');
  assert.ok(recorded.manifest.filesCompared > 9000);
});

function rig(pageSize = 2) {
  let listing = [];
  let gate = null;
  let reached = null;
  const listeners = new Set();
  const stores = new Set();
  const requests = [];
  const client = {
    call: async (method, params) => {
      requests.push({ method, params });
      assert.equal(method, 'thread/list');
      if (gate) {
        reached?.();
        await gate;
      }
      const rows = listing;
      const from = params.cursor ? Number(params.cursor) : 0;
      const data = rows.slice(from, from + pageSize);
      return { data, ...(from + pageSize < rows.length ? { nextCursor: String(from + pageSize) } : {}) };
    },
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    store: { subscribe: (listener) => (stores.add(listener), () => stores.delete(listener)) },
  };
  const published = [];
  const waiting = [];
  const feed = createRosterFeed({
    summaries: (rows) => summariesOfThreadRows(rows),
    publish: (rows) => {
      published.push(plain(rows));
      waiting.splice(0).forEach((resolve) => resolve());
    },
  });
  feed.attach(client);
  return {
    feed,
    client,
    published,
    requests,
    setListing: (rows) => (listing = rows),
    /** Resolves at the feed's next publication (the completion of a list read). */
    published_: () => new Promise((resolve) => waiting.push(resolve)),
    /** Holds the listing; `arrived` resolves when a read has reached the hold. */
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      const arrived = new Promise((resolve) => (reached = resolve));
      return {
        arrived,
        release: () => {
          gate = null;
          release();
        },
      };
    },
    edge: (method, params) => listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
    store: (change) => stores.forEach((l) => l(change)),
  };
}

/** The step's recorded app-feed events, in the order they were recorded. */
const feedEdges = (s) => s.edges;
/** The feed reads the list when the app feed first snapshots; resolves when that read has been published. */
async function attached(r, rows) {
  r.setListing(rows);
  const done = r.published_();
  r.store({ type: 'appSnapshot' });
  await done;
}

const step = (name) => recorded.steps.find((s) => s.name === name);

test('attach: the whole list is read, in pages, and published once as Node\'s baseline was', async () => {
  const s = step('attach-baseline');
  const r = rig();
  await attached(r, s.coreRows);
  assert.deepEqual(r.published, s.published);
  assert.ok(r.requests.length > 1 && r.requests.every((q) => q.params.limit === 1000), 'every page follows the cursor');
  assert.deepEqual(r.requests.slice(1).map((q) => q.params.cursor), ['2', '4'].slice(0, r.requests.length - 1));
});

test('a pushed edge changes the list as Node\'s live roster push did', async () => {
  const [attach, live] = ['attach-baseline', 'live-push'].map(step);
  const r = rig();
  await attached(r, attach.coreRows);
  r.published.length = 0;
  for (const { method, params } of feedEdges(live)) r.edge(method, params);
  assert.deepEqual(r.published, live.published);
});

test('an edge that changes nothing publishes nothing (Node skipped an unchanged roster)', async () => {
  const [live, same] = ['live-push', 'live-push-unchanged'].map(step);
  const r = rig();
  await attached(r, live.coreRows);
  r.published.length = 0;
  for (const { method, params } of feedEdges(same)) r.edge(method, params);
  assert.deepEqual(r.published, same.published);
  assert.deepEqual(same.published, []);
});

test('restart: the app feed coming back re-reads the whole list, and rows gone while the core was away are gone', async () => {
  const [, live, same, changed] = ['attach-baseline', 'live-push', 'restart-same-roster', 'restart-roster-changed'].map(step);
  const r = rig();
  await attached(r, live.coreRows);
  r.published.length = 0;
  // The core restarts with the same rows: no edge is republished, the list is read again.
  let done = r.published_();
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await done;
  assert.deepEqual(r.published, same.published);
  // Restarts again after rows changed while it was away: no edge announces them.
  r.published.length = 0;
  r.setListing(changed.coreRows);
  done = r.published_();
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await done;
  assert.deepEqual(r.published, changed.published);
  assert.equal(changed.published[0].some((row) => row.id === 'sess_3'), false);
});

test('a change between re-subscribing and the list outranks the listing, as Node\'s pushed roster did', async () => {
  const [changed, between, after] = ['restart-roster-changed', 'change-between-subscribe-and-list', 'live-push-after-restart'].map(step);
  const r = rig();
  await attached(r, changed.coreRows);
  r.published.length = 0;
  const { arrived, release } = r.hold();
  const done = r.published_();
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await arrived;
  // The listing is still being read (it will answer with the older rows) when the core announces the change.
  for (const { method, params } of feedEdges(between)) r.edge(method, params);
  release();
  await done;
  assert.deepEqual(r.published, between.published);
  r.published.length = 0;
  for (const { method, params } of feedEdges(after)) r.edge(method, params);
  assert.deepEqual(r.published, after.published);
});

test('the order is Node\'s byActivityThenId, ties and rows without activity included, whether listed or announced one by one', async () => {
  const s = step('order-ties');
  const ids = (rows) => rows.map((row) => row.id);
  const listed = rig();
  await attached(listed, s.coreRows);
  assert.deepEqual(ids(listed.published[0]), s.order);
  // Announced in the reverse of Node's order, one recorded edge at a time, after an empty list.
  const announced = rig();
  await attached(announced, []);
  announced.published.length = 0;
  for (const { method, params } of feedEdges(s)) announced.edge(method, params);
  assert.deepEqual(ids(announced.published.at(-1)), s.order);
});

test('a lost app feed is read again at the next snapshot', async () => {
  const attach = step('attach-baseline');
  const r = rig();
  await attached(r, attach.coreRows);
  r.store({ type: 'subscription', feedId: 'app', state: 'lost' });
  r.published.length = 0;
  const done = r.published_();
  r.store({ type: 'appSnapshot' });
  await done;
  assert.deepEqual(r.published, attach.published);
});
// ── PH-1: a wired chat call's requests carry that call's transmission claim ─────────────────────────────────────────────────────────
/** Every request of four chat calls through the real router; `wire` may replace what the adapter is handed. */
async function writtenThrough(wire = (adapter) => adapter) {
  const written = [];
  const client = {
    call: async (method, params, options) => {
      written.push({ method, params, sent: options?.sent });
      return method === 'thread/list' ? { data: [] } : {};
    },
    resumeThread: async (threadId, window, options) => (written.push({ method: 'thread/resume', sent: options?.sent }), {}),
    unsubscribeThread: async (threadId, options) => (written.push({ method: 'thread/unsubscribe', sent: options?.sent }), undefined),
    server: { connection: { device: 'Phone' } },
  };
  const made = [];
  const adapter = createChatAdapter({
    sharedFor: (handed) => {
      made.push(handed);
      const protocol = {
        call: (method, params) => handed.call(method, params),
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
  const router = createProtocolRouter([wire(adapter, client)], { host, started: async () => undefined, synced: async () => undefined, probe() {}, silentSince: () => false });
  await router.call('markSessionRead', ['sess_a', 3, true]);
  await router.call('renameSession', ['sess_a', 'New name']);
  await router.call('listSessions', []);
  await router.call('deleteSession', ['sess_a']).catch(() => undefined);
  return { written, made, client };
}

test('a chat call wired through the router writes every request with its own claim', async () => {
  const { written, made, client } = await writtenThrough();
  assert.ok(written.length >= 4);
  for (const request of written) assert.equal(typeof request.sent, 'function', `${request.method} carries its call's claim`);
  assert.equal(new Set(written.map((w) => w.sent)).size >= 4, true, 'each call has a claim of its own');
  assert.equal(made.length >= 3, true, 'the adapter is built per call from the scoped client, not once');
  assert.ok(made.every((c) => c !== client), "what the adapter was built from is the call's scoped client");
});

// Negative control: the same adapter built once from a captured client (what `install` hands over) loses every claim, so the test above
// would fail for it.
test('negative control: an adapter built once with a captured client writes unclaimed requests', async () => {
  const captured = (adapter, client) => {
    const calls = Object.fromEntries(Object.entries(adapter.calls).map(([name, call]) => [name, (params, host) => call(params, { ...host, client: () => client })]));
    return { ...adapter, calls };
  };
  const { written } = await writtenThrough(captured);
  assert.ok(written.length >= 4);
  assert.ok(written.every((request) => request.sent === undefined), 'no request carries a claim');
});

test('the adapter the switch point loads claims all 37 chat calls and the thread list, and nothing twice', async () => {
  const { adapter } = await import('./remote-protocol-chat.ts');
  const names = [
    'abortSession', 'agentRoomAction', 'answerApprovalNotification', 'cancelQuotaResume', 'continueSessionInModel', 'deleteSession', 'getQuotaAutoResume',
    'getTaskWorkspace', 'inheritSession', 'listProviderModels', 'markSessionRead', 'openAgentHome', 'prefetchSession', 'provideSecretInput',
    'readCapabilities', 'readTranscriptHistory', 'readTranscriptItem', 'releaseShellJob', 'renameSession', 'resetAgentHome',
    'resolveToolApprovalForSession', 'scheduleQuotaResume', 'searchSessionContent', 'setFast', 'setModelRoute', 'setQuotaAutoResume',
    'setSessionArchived', 'setSessionFavorite', 'setSessionProject', 'startProject', 'startProjectTask', 'startTask', 'stopShellJob',
    'submitFeedback', 'submitNewTask', 'submitToSession', 'viewerDevice',
  ];
  assert.equal(adapter.group, 'chat');
  assert.deepEqual(Object.keys(adapter.calls).sort(), [...names, 'listSessions'].sort());
});
