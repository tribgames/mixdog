// The phone's thread list on an attach: the requests a restore costs, a snapshot that overtakes a read, and one pairing's list never
// reaching another's (decisions: the list is kept in memory only, bound to the client it was read over).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatAdapter, createRosterFeed } from './remote-protocol-chat.ts';

const row = (id, at, name = id) => ({ id, name, activityAt: at, updatedAt: at });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function rig(listing = [], pageSize = 2) {
  const requests = [];
  const listeners = new Set();
  const stores = new Set();
  const published = [];
  let hold = null;
  const client = {
    call: async (method, params) => {
      requests.push({ method, params });
      const from = params.cursor ? Number(params.cursor) : 0;
      const page = {
        data: listing.slice(from, from + pageSize),
        ...(from + pageSize < listing.length ? { nextCursor: String(from + pageSize) } : {}),
      };
      if (hold && from === pageSize) await hold.promise;
      return page;
    },
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    store: { subscribe: (listener) => (stores.add(listener), () => stores.delete(listener)) },
  };
  const feed = createRosterFeed({
    summaries: (rows) => rows.map((r) => `${r.id}:${r.name}`),
    publish: (rows) => published.push(rows),
  });
  feed.attach(client);
  return {
    feed,
    client,
    requests,
    published,
    setListing: (rows) => (listing = rows),
    /** Holds the answer to page two of the next reads. */
    holdPageTwo() {
      let release;
      hold = { promise: new Promise((resolve) => (release = resolve)) };
      return () => {
        const h = hold;
        hold = null;
        release();
        return h;
      };
    },
    edge: (method, params) => listeners.forEach((l) => l({ type: 'notification', notification: { method, params } })),
    store: (change) => stores.forEach((l) => l(change)),
  };
}

async function attached(r, rows) {
  r.setListing(rows);
  r.store({ type: 'appSnapshot' });
  await settle();
}

test('an unchanged restore sends no request: a restored subscription (a replay) reads nothing and the page is answered from the held list', async () => {
  const r = rig();
  await attached(r, [row('a', 30), row('b', 20), row('c', 10)]);
  const before = r.requests.length;
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  await settle();
  assert.equal(r.requests.length, before, 'no request for a restore that replays');
  assert.deepEqual(r.feed.current(), ['a:a', 'b:b', 'c:c']);
});

test('the changes a replay carries are applied to the held list, still without a read', async () => {
  const r = rig();
  await attached(r, [row('a', 30), row('b', 20), row('c', 10)]);
  const before = r.requests.length;
  r.store({ type: 'subscription', feedId: 'app', state: 'restored' });
  r.edge('thread/summary/updated', { thread: row('b', 40, 'renamed') });
  r.edge('thread/deleted', { threadId: 'c' });
  assert.equal(r.requests.length, before);
  assert.deepEqual(r.feed.current(), ['b:renamed', 'a:a']);
});

test('a snapshot (a core restart, a position the core no longer holds) reads the list in pages and lays the edges that arrive over it', async () => {
  const r = rig();
  await attached(r, [row('a', 30), row('b', 20)]);
  const before = r.requests.length;
  r.setListing([row('a', 30), row('b', 20), row('c', 10), row('d', 5), row('e', 1)]);
  r.store({ type: 'appSnapshot' });
  assert.equal(r.feed.current(), undefined, 'the held list is not served as exact while it is read');
  r.edge('thread/deleted', { threadId: 'e' });
  await settle();
  assert.equal(r.requests.length - before, 3, 'five rows in pages of two');
  assert.deepEqual(r.feed.current(), ['a:a', 'b:b', 'c:c', 'd:d']);
});

test('a snapshot while a read is on its second page abandons that read: the row deleted in the gap is not served', async () => {
  const r = rig();
  r.setListing([row('a', 30), row('b', 20), row('c', 10), row('d', 5)]);
  const release = r.holdPageTwo();
  r.store({ type: 'appSnapshot' }); // the first read: page one is in, page two is pending
  await settle();
  // The core's answer to the second attach: a snapshot, the listing now without `c` (deleted in the gap).
  r.setListing([row('a', 30), row('b', 20), row('d', 5)]);
  r.store({ type: 'appSnapshot' });
  release();
  await settle();
  await settle();
  assert.deepEqual(r.feed.current(), ['a:a', 'b:b', 'd:d']);
  assert.equal(r.published.at(-1).includes('c:c'), false, 'no publication carried the superseded read');
});

test('a retired roster serves nothing of the old list', async () => {
  const r = rig([row('a', 30)]);
  await attached(r, [row('a', 30)]);
  assert.deepEqual(r.feed.current(), ['a:a']);
  r.feed.retire();
  assert.equal(r.feed.current(), undefined);
});

test('a client that replaces the first one (a re-pairing in the same page) is listened to, and starts from an empty list', async () => {
  const catalogs = [];
  const makeClient = (rows) => {
    const stores = new Set();
    const listeners = new Set();
    return {
      stores,
      call: async () => ({ data: rows }),
      on: (l) => (listeners.add(l), () => listeners.delete(l)),
      store: { subscribe: (l) => (stores.add(l), () => stores.delete(l)) },
    };
  };
  const first = makeClient([row('old', 9)]);
  const second = makeClient([row('new', 9)]);
  const adapter = createChatAdapter({
    sharedFor: () => ({}),
    remoteSession: () => undefined,
    roster: { summaries: (rows) => rows.map((r) => r.id) },
  });
  let handOver;
  let resetPairing;
  const host = {
    ctx: {
      sessionsCatalog: { publish: (rows) => catalogs.push(rows) },
      phone: { start: async () => undefined },
      sessionInbox: { publish() {} },
      viewSettledListeners: new Set(),
    },
    client: () => first,
    declareLane() {},
    onClient: (listener) => ((handOver = listener), listener(first), () => undefined),
    onPairingReset: (listener) => ((resetPairing = listener), () => undefined),
  };
  adapter.install(host);
  for (const l of first.stores) l({ type: 'appSnapshot' });
  await settle();
  assert.deepEqual(await adapter.calls.listSessions([], host), ['old'], "the first pairing's list");
  resetPairing();
  assert.equal(first.stores.size, 0, 'sign-out immediately detaches, before a new pairing');
  host.client = () => second;
  handOver(second);
  assert.equal(first.stores.size, 0, 'the old client is no longer listened to');
  for (const l of second.stores) l({ type: 'appSnapshot' });
  await settle();
  assert.deepEqual(catalogs, [['old'], ['new']], 'the replacement client drives publication');
  assert.deepEqual(await adapter.calls.listSessions([], host), ['new'], 'none of the first is served');
});
