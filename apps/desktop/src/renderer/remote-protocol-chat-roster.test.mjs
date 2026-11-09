// The phone's thread list through a daemon restart, against Node's recording (remote-protocol-chat-roster.recorded.json, recorded by
// remote-protocol-chat-roster.record.mjs from the exact b6f10295a export): the roster Node's phone published for each scripted action, attach,
// restart and mid-read change, against what the phone feed publishes from a RUNNING mixdogd's 	hread/list pages and app-feed edges
// (remote-protocol-chat-live.recorded.json, inputs only). Plus: a wired chat call's requests carry that call's claim.
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
import { assertParity, createParity } from './remote-protocol-chat-parity.mjs';

// The router's call deadline reads the page's timers (remote-shim-call-watch.ts); a Node test has no window.
globalThis.window ??= globalThis;

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const node = read('./remote-protocol-chat-roster.recorded.json');
const live = read('./remote-protocol-chat-live.recorded.json');
const plain = (value) => JSON.parse(JSON.stringify(value));
const parity = createParity({ live, node, project: (rows) => summariesOfThreadRows(plain(rows)) });
const nodeStep = (name) => node.steps.find((s) => s.name === name);
const liveStep = (name) => live.steps.find((s) => s.name === name);
const actions = node.manifest.actions;

test('the recording is an exact Node b6f10295a manifest', () => {
  assert.equal(node.manifest.exact, true);
  assert.equal(node.manifest.commit, 'b6f10295a2f698afc85332467192de28500bd146');
  assert.ok(node.manifest.filesCompared > 9000);
  assert.deepEqual(actions, live.steps.map((s) => s.name), 'Node and the live core ran the same actions');
});

test('Node times map to live times in order', (t) => {
  assertParity(t, parity.timeOrderBreaks());
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
      const from = params.cursor ? Number(params.cursor) : 0;
      const data = listing.slice(from, from + pageSize);
      return { data, ...(from + pageSize < listing.length ? { nextCursor: String(from + pageSize) } : {}) };
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
    /** Holds the listing; ``arrived`` resolves when a read has reached the hold. */
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      const arrived = new Promise((resolve) => (reached = resolve));
      return { arrived, release: () => { gate = null; release(); } };
    },
    edge: ({ method, params }) => listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
    store: (change) => stores.forEach((l) => l(change)),
  };
}

/** The feed reads the list when the app feed first snapshots; resolves when that read has been published. */
async function attached(r, rows) {
  r.setListing(rows);
  const done = r.published_();
  r.store({ type: 'appSnapshot' });
  await done;
}
const listOf = (name) => liveStep(name).listed.data;
const finalRoster = (r) => r.published.at(-1);

// ── every comparison below is the phone's whole roster against the whole roster Node's phone published, in Node's order ──────────────

for (const name of actions) {
  test(`attach (${name}): the whole list is read, in pages, and published once as Node's baseline was`, async (t) => {
    const r = rig();
    await attached(r, listOf(name));
    assert.equal(r.published.length, 1);
    assert.equal(nodeStep(`attach:${name}`).published.length, 1);
    assertParity(t, parity.classify(nodeStep(`attach:${name}`).roster, finalRoster(r)));
    assert.ok(r.requests.length > 1 && r.requests.every((q) => q.params.limit === 1000), 'every page follows the cursor');
    assert.deepEqual(r.requests.slice(1).map((q) => q.params.cursor), ['2', '4'].slice(0, r.requests.length - 1));
  });
}

actions.slice(1).forEach((name, at) => {
  const prev = actions[at];
  test(`restart (${prev} > ${name}): the app feed coming back re-reads the whole list; rows gone while the core was away are gone`, async (t) => {
    const r = rig();
    await attached(r, listOf(prev));
    r.published.length = 0;
    r.setListing(listOf(name));
    const done = r.published_();
    r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
    await done;
    assert.equal(r.published.length, 1);
    assertParity(t, parity.classify(nodeStep(`restart:${prev}>${name}`).roster, finalRoster(r)));
  });

  test(`between (${prev} > ${name}): a change between re-subscribing and the list outranks the listing, as Node's pushed roster did`, async (t) => {
    const r = rig();
    await attached(r, listOf(prev));
    r.published.length = 0;
    const { arrived, release } = r.hold();
    const done = r.published_();
    r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
    await arrived;
    // The listing is still being read (it will answer with the older rows) when the core's own edges for the action arrive.
    for (const edge of liveStep(name).edges) r.edge(edge);
    release();
    await done;
    assertParity(t, parity.classify(nodeStep(`between:${prev}>${name}`).roster, finalRoster(r)));
  });
});

test('an edge that changes nothing publishes nothing (Node skipped an unchanged roster)', async () => {
  const r = rig();
  await attached(r, listOf('delete'));
  r.published.length = 0;
  // The core's own last announcement of the one session nothing touched afterwards (Title 4), delivered again.
  const title4 = live.made.sess_4;
  const last = live.steps.flatMap((s) => s.edges).filter((e) => e.params.thread?.id === title4).at(-1);
  r.edge(last);
  assert.deepEqual(r.published, nodeStep('unchanged:delete').published);
  assert.deepEqual(nodeStep('unchanged:delete').published, []);
});

test('a lost app feed is read again at the next snapshot', async (t) => {
  const r = rig();
  await attached(r, listOf('turns'));
  r.store({ type: 'subscription', feedId: 'app', state: 'lost' });
  r.published.length = 0;
  const done = r.published_();
  r.store({ type: 'appSnapshot' });
  await done;
  assertParity(t, parity.classify(nodeStep('attach:turns').roster, finalRoster(r)));
});

test('the order is Node\'s byActivityThenId: ties and rows without activity included', async () => {
  const s = nodeStep('order-ties');
  const r = rig();
  await attached(r, s.coreRows);
  assert.deepEqual(r.published[0].map((row) => row.id), s.order);
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
