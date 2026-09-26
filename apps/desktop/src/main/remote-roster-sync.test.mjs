import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAndSynchronizeRelayViews } from './remote-view-sync.ts';
import { createRelayClientRegistry } from './remote-relay-clients.ts';
import { createRelayCatalogs } from './remote-relay-catalog.ts';
import { createKeyedListDeltaDecoder, createKeyedListDeltaEncoder } from '../shared/list-delta.ts';
import { createRemoteRosterCache, readRosterClaim } from '../shared/remote-roster-cache.ts';

const plain = (value) => JSON.parse(JSON.stringify(value));
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const ROWS = 1_800;

/** A roster shaped like the real one: ~1,800 rows, ~450 bytes each. */
function roster(count = ROWS) {
  return Array.from({ length: count }, (_, index) => ({
    id: `0190c3f2-7a1b-7c3d-9e4f-${String(index).padStart(12, '0')}`,
    preview: `Session ${index} preview: ${'lorem ipsum dolor sit amet '.repeat(7)}`.slice(0, 200),
    title: `Session number ${index}`,
    updatedAt: 1_780_000_000_000 - index * 60_000,
    activityAt: 1_780_000_000_000 - index * 60_000,
    messageCount: 40 + (index % 17),
    readMessageCount: 40 + (index % 17),
    readRevision: index % 5,
    cwd: `C:\\Project\\workspace-${index % 23}`,
    classification: index % 3 === 0 ? 'project' : 'task',
    projectPath: index % 3 === 0 ? `C:\\Project\\workspace-${index % 23}` : null,
    provider: 'anthropic',
    model: 'claude-opus',
  }));
}

function desktop(sessions = roster()) {
  const host = {
    sessions,
    getSnapshot: () => ({ sessionId: null, status: 'idle', items: [], streamingTail: null }),
    listSessions: async () => host.sessions,
    listAgentPool: async () => [],
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (ids, deliver) => deliver([]),
  };
  const registry = createRelayClientRegistry({
    host,
    sendEnvelope: () => {},
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
    now: () => 0,
  });
  const clients = new Map();
  let delivered = null;
  const catalogs = createRelayCatalogs({
    host,
    clients,
    live: () => true,
    sendEncryptedFrame: async (_clientId, frame) => delivered?.(frame),
  });
  let count = 0;
  /** One relay leg into `phone`; frames cross a JSON round trip. */
  const connect = (phone) => {
    const clientId = `client-${++count}`;
    const state = registry.open(clientId, {});
    clearTimeout(state.handshakeTimer);
    Object.assign(state, { channel: {}, viewSync: true, compactWire: true, listDelta: true, stateLane: null });
    clients.clear();
    clients.set(clientId, state);
    delivered = (frame) => phone.apply(JSON.parse(JSON.stringify(frame)));
    const sync = async (rosterParam) => {
      const frames = [];
      const params = rosterParam === undefined ? [[], null] : [[], null, undefined, rosterParam];
      const value = await registerAndSynchronizeRelayViews(host, clientId, state, params, () => true, async (frame) => {
        frames.push(plain(frame));
        delivered(frame);
      });
      const sessions = frames.filter((frame) => frame.event === 'sessions' || frame.payload?.frame?.event === 'sessions');
      const bytes = sessions.reduce((total, frame) => total + JSON.stringify(frame).length, 0);
      return { value, frames, sessions, bytes };
    };
    return { clientId, state, sync };
  };
  return { host, registry, catalogs, connect };
}

function memoryStorage() {
  let record;
  return {
    load: async () => (record === undefined ? undefined : structuredClone(record)),
    save: async (value) => {
      record = structuredClone(value);
    },
    clear: async () => {
      record = undefined;
    },
    get record() {
      return record;
    },
    set record(value) {
      record = value;
    },
  };
}

/** The phone as remote-shim.ts runs it; `legacy` is a build without a cache. */
function phone(storage, scope = 'relay\ndevice\npublic-key\nsecret', legacy = false) {
  const decoder = createKeyedListDeltaDecoder();
  const mismatches = [];
  const cache = legacy
    ? null
    : createRemoteRosterCache({
        storage,
        scope: () => scope,
        decoder,
        saveDelayMs: 0,
        onMismatch: () => mismatches.push(true),
      });
  const view = { sessions: null };
  return {
    view,
    decoder,
    mismatches,
    claim: () => cache?.claim(),
    apply(frame) {
      if (frame.event !== 'sessions') return;
      const decoded = decoder.decode(frame.payload);
      assert.equal(decoded.ok, true, 'a sessions frame applies to exactly the rows it was encoded against');
      view.sessions = decoded.items;
      cache?.observe(frame.payload);
    },
  };
}

/** The encoder's state after a catch-up is the state a full baseline leaves. */
function assertEncoderMatchesBaseline(state, rows) {
  const reference = createKeyedListDeltaEncoder((session, index) => String(session.id || `session:${index}`));
  reference.encode(rows);
  assert.deepEqual(state.sessionsEncoder.resumePoint().held, reference.resumePoint().held);
}

async function persisted(d, storage) {
  const first = phone(storage);
  const full = await d.connect(first).sync(await first.claim());
  assert.deepEqual(first.view.sessions, plain(d.host.sessions));
  await wait();
  assert.ok(storage.record, 'the decoded roster is persisted');
  return full;
}

test('a cold open with an unchanged persisted roster sends one tiny frame, and live deltas keep applying', async () => {
  const d = desktop();
  const storage = memoryStorage();
  const full = await persisted(d, storage);
  assert.ok(full.bytes > 700_000, `full roster ${full.bytes} bytes`);

  const reopened = phone(storage);
  const claim = await reopened.claim();
  assert.ok(JSON.stringify(claim).length < 160, `uplink claim ${JSON.stringify(claim).length} bytes`);
  const leg = d.connect(reopened);
  const cold = await leg.sync(claim);
  assert.equal(cold.sessions.length, 1);
  assert.ok(cold.bytes < 300, `unchanged cold open ${cold.bytes} bytes vs ${full.bytes} full`);
  assert.deepEqual(reopened.view.sessions, plain(d.host.sessions));
  assertEncoderMatchesBaseline(leg.state, d.host.sessions);
  await wait();
  assert.deepEqual(reopened.mismatches, []);

  // (e) Live roster pushes through the relay catalog still apply as patches.
  d.host.sessions = [{ ...d.host.sessions[0], working: true }, ...d.host.sessions.slice(1)];
  d.catalogs.publishSessions(d.host.sessions);
  d.host.sessions = [{ ...d.host.sessions[0], id: 'brand-new' }, ...d.host.sessions];
  d.catalogs.publishSessions(d.host.sessions);
  assert.deepEqual(reopened.view.sessions, plain(d.host.sessions));
  await wait();

  // Those stamped pushes moved the persisted copy forward: the next cold open
  // is tiny again.
  const again = phone(storage);
  const next = await d.connect(again).sync(await again.claim());
  assert.ok(next.bytes < 300, `${next.bytes} bytes`);
  assert.deepEqual(again.view.sessions, plain(d.host.sessions));
  console.info(`[roster] full=${full.bytes}B unchanged-cold-open=${cold.bytes}B claim=${JSON.stringify(claim).length}B`);
});

test('a few changed, added and deleted rows send just those and rebuild the identical roster', async () => {
  const d = desktop();
  const storage = memoryStorage();
  const full = await persisted(d, storage);

  const rows = d.host.sessions;
  const touched = [rows[5], rows[900]].map((row, index) => ({
    ...row,
    updatedAt: 1_790_000_000_000 + index,
    messageCount: row.messageCount + 2,
    preview: `new reply ${index}`,
  }));
  const added = [0, 1].map((index) => ({ ...rows[10], id: `added-${index}`, title: `Added ${index}` }));
  const deleted = new Set([rows[20].id, rows[1_500].id]);
  // A heartbeat that does NOT advance updatedAt, deep in the list.
  const heartbeat = { ...rows[1_200], working: true };
  d.host.sessions = [
    ...added,
    ...touched,
    ...rows.filter((row, index) => !deleted.has(row.id) && index !== 5 && index !== 900).map((row) =>
      row.id === heartbeat.id ? heartbeat : row
    ),
  ];

  const reopened = phone(storage);
  const leg = d.connect(reopened);
  const cold = await leg.sync(await reopened.claim());
  const payload = cold.sessions[0].payload.__listCatch;
  assert.ok(payload, 'answered with a catch-up');
  assert.deepEqual(payload.upsert.map(([key]) => key).sort(), [...added, ...touched, heartbeat].map((row) => row.id).sort());
  assert.deepEqual(payload.removed.sort(), [...deleted].sort());
  assert.deepEqual(reopened.view.sessions, plain(d.host.sessions));
  assertEncoderMatchesBaseline(leg.state, d.host.sessions);
  await wait();
  assert.deepEqual(reopened.mismatches, []);
  assert.ok(cold.bytes * 5 < full.bytes, `few-changed cold open ${cold.bytes} bytes vs ${full.bytes} full`);
  console.info(`[roster] full=${full.bytes}B few-changed-cold-open=${cold.bytes}B`);

  // Unchanged rows that swap places cannot be rebuilt from a head: the whole
  // order travels, still without the rows.
  await wait();
  const swapped = [...d.host.sessions];
  [swapped[100], swapped[101]] = [swapped[101], swapped[100]];
  d.host.sessions = swapped;
  const moved = phone(storage);
  const reorder = await d.connect(moved).sync(await moved.claim());
  assert.ok(reorder.sessions[0].payload.__listCatch.order);
  assert.deepEqual(moved.view.sessions, plain(d.host.sessions));
});

test('no persisted copy, another desktop, an id-set mismatch or tampered rows fall back to the full baseline', async () => {
  const d = desktop();
  const storage = memoryStorage();
  const full = await persisted(d, storage);
  const isBaseline = (result) =>
    result.sessions.length === 1 &&
    Object.hasOwn(result.sessions[0].payload.frame?.payload ?? result.sessions[0].payload, '__listRevision');

  // No persisted copy: the claim holds nothing.
  const empty = phone(memoryStorage());
  const emptyClaim = await empty.claim();
  assert.deepEqual(emptyClaim, { v: 1 });
  assert.ok(isBaseline(await d.connect(empty).sync(emptyClaim)));
  assert.deepEqual(empty.view.sessions, plain(d.host.sessions));

  // Another pairing never reads this record, and drops it.
  const other = phone(storage, 'relay\ndevice\nother-key\nsecret');
  assert.deepEqual(await other.claim(), { v: 1 });
  assert.equal(storage.record, undefined);

  // Another desktop process (fresh log epoch) cannot answer the claim.
  await persisted(d, storage);
  const elsewhere = desktop(d.host.sessions);
  const foreign = phone(storage);
  const foreignResult = await elsewhere.connect(foreign).sync(await foreign.claim());
  assert.ok(isBaseline(foreignResult));
  assert.ok(foreignResult.bytes > full.bytes / 2);
  assert.deepEqual(foreign.view.sessions, plain(d.host.sessions));

  // The phone's id set differs from what the claimed version held.
  await persisted(d, storage);
  storage.record = { ...storage.record, held: storage.record.held.slice(1) };
  const short = phone(storage);
  assert.ok(isBaseline(await d.connect(short).sync(await short.claim())));
  assert.deepEqual(short.view.sessions, plain(d.host.sessions));

  // Same ids, altered content: the desktop cannot see it, the rebuilt digest
  // does — the phone drops the copy and asks for a baseline.
  await persisted(d, storage);
  const held = storage.record.held.map(([key, row], index) => [key, index === 7 ? { ...row, title: 'stale' } : row]);
  storage.record = { ...storage.record, held };
  const tampered = phone(storage);
  await d.connect(tampered).sync(await tampered.claim());
  await wait();
  assert.equal(tampered.mismatches.length, 1);
  assert.equal(storage.record, undefined, 'the unproven copy is dropped');
  assert.deepEqual(await tampered.claim(), { v: 1 }, 'the resync asks for a baseline');
});

test('an old phone and an old desktop keep the plain baseline', async () => {
  const d = desktop();
  // Old phone: no fourth parameter, no stamp, no catch-up, same bytes.
  const legacy = phone(null, null, true);
  const leg = d.connect(legacy);
  const old = await leg.sync();
  assert.equal(old.value, true);
  assert.equal(leg.state.rosterStamp, false);
  const payload = old.sessions[0].payload.frame?.payload ?? old.sessions[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ['__listRevision', 'rows']);
  d.host.sessions = [{ ...d.host.sessions[0], working: true }, ...d.host.sessions.slice(1)];
  d.catalogs.publishSessions(d.host.sessions);
  assert.deepEqual(legacy.view.sessions, plain(d.host.sessions));

  // Old desktop: the claim is ignored and a baseline replaces the seeded rows.
  const storage = memoryStorage();
  await persisted(d, storage);
  const reopened = phone(storage);
  await reopened.claim();
  await d.connect(reopened).sync();
  assert.deepEqual(reopened.view.sessions, plain(d.host.sessions));
  assert.equal(readRosterClaim(undefined), null);
  assert.deepEqual(readRosterClaim({ v: 1, e: 'bad epoch!', r: 1, n: 1, ids: 'x' }), { claim: null });
});
