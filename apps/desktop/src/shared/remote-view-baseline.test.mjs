import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRemoteViewBaselineCache, readViewBaselineOffer } from './remote-view-baseline.ts';
import { registerAndSynchronizeRelayViews } from '../main/remote-view-sync.ts';
import { createRemoteStateLane } from '../main/remote-state-lane.ts';
import { createSnapshotDeltaDecoder } from '../main/state-delta.ts';
import { createKeyedListDeltaEncoder } from './list-delta.ts';

const baseline = (text) => {
  const frame = { event: 'sessionState', payload: { sessionId: 'session', text } };
  return { key: createHash('sha256').update(JSON.stringify(frame)).digest('hex'), frame };
};

test('retained baselines are bounded, pinned during recovery and isolated from consumer mutation', () => {
  let now = 0;
  const a = baseline('a'.repeat(120));
  const b = baseline('b'.repeat(120));
  const cache = createRemoteViewBaselineCache(JSON.stringify(a.frame).length * 2 + 8, () => now);
  cache.restore(a).payload.text = 'mutated by consumer';
  const first = cache.begin();
  cache.restore(b); // Evicts a from the next offer, but not from this request.
  assert.equal(cache.restore({ key: a.key }).payload.text, a.frame.payload.text);
  first.finish();
  assert.throws(() => cache.restore({ key: a.key }), /no longer available/);
  const second = cache.begin();
  assert.deepEqual(second.offer.keys, [b.key]);
  first.finish(); // An obsolete request cannot release a replacement's pins.
  assert.deepEqual(cache.restore({ key: b.key }), b.frame);
  second.finish();
  now = 300_001;
  assert.deepEqual(cache.begin().offer.keys, []);
  cache.restore(a);
  cache.begin();
  cache.clear();
  assert.throws(() => cache.restore({ key: a.key }), /no longer available/);
  assert.equal(readViewBaselineOffer({ version: 1, keys: ['invalid'] }), null);
  assert.equal(readViewBaselineOffer({ version: 2, keys: [] }), null);
  assert.equal(readViewBaselineOffer({ version: 1, keys: Array(133).fill(a.key) }), null);
});

test('successful retained references renew expiry without reviving evicted or cleared entries', () => {
  let now = 0;
  const a = baseline('a'.repeat(120));
  const b = baseline('b'.repeat(120));
  const cache = createRemoteViewBaselineCache(JSON.stringify(a.frame).length * 2 + 8, () => now);
  cache.restore(a);
  now = 240_000;
  const reference = cache.begin();
  assert.deepEqual(cache.restore({ key: a.key }), a.frame);
  reference.finish();
  now = 300_001;
  const renewed = cache.begin();
  assert.deepEqual(renewed.offer.keys, [a.key]);
  renewed.finish();
  now = 540_001;
  const expired = cache.begin();
  assert.deepEqual(expired.offer.keys, [], 'advertising alone must not extend expiry');
  expired.finish();

  cache.restore(a);
  const pinned = cache.begin();
  cache.restore(b);
  assert.deepEqual(cache.restore({ key: a.key }), a.frame);
  pinned.finish();
  const retained = cache.begin();
  assert.deepEqual(retained.offer.keys, [b.key], 'a pinned reference must not undo byte-limit eviction');
  cache.clear();
  assert.throws(() => cache.restore({ key: b.key }), /no longer available/);
  retained.finish();
  assert.deepEqual(cache.begin().offer.keys, []);
});

test('reconnect references only identical full baselines and rebuilds a usable delta decoder', async () => {
  let snapshot = {
    sessionId: 'session',
    streamingTail: null,
    items: [{ id: 'one', text: 'unchanged transcript '.repeat(500) }],
  };
  const sessions = [{ id: 'session', title: 'session' }];
  const host = {
    getSnapshot: () => snapshot,
    listSessions: async () => sessions,
    listAgentPool: async () => [],
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (_ids, deliver) => deliver([{ sessionId: 'session', snapshot, frameSource: 'replay' }]),
  };
  const makeState = () => ({
    visibleSessionIds: new Set(),
    compactWire: false,
    listDelta: true,
    sessionStateEncoders: new Map(),
    sessionsEncoder: createKeyedListDeltaEncoder((row) => row.id),
    agentPoolEncoder: createKeyedListDeltaEncoder((row) => row.sessionId),
    stateLane: createRemoteStateLane(false, async () => {
      throw new Error('Baseline bypassed synchronization.');
    }),
  });
  const cache = createRemoteViewBaselineCache();
  const sync = async (state, offer = cache.begin()) => {
    const frames = [];
    const restored = [];
    try {
      await registerAndSynchronizeRelayViews(
        host,
        'client',
        state,
        [['session'], offer.offer],
        () => true,
        async (frame) => {
          frames.push(frame);
          restored.push(frame.event === 'viewBaseline' ? cache.restore(frame.payload) : frame);
        }
      );
      return { frames, restored };
    } finally {
      offer.finish();
    }
  };
  const first = await sync(makeState());
  assert.equal(first.frames.length, 4);
  assert.ok(first.frames.every((frame) => frame.payload.frame));
  const replacement = makeState();
  const repeated = await sync(replacement);
  assert.ok(repeated.frames.every((frame) => !Object.hasOwn(frame.payload, 'frame')));
  assert.ok(JSON.stringify(repeated.frames).length < JSON.stringify(first.frames).length / 10);
  assert.deepEqual(repeated.restored, first.restored);
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode(repeated.restored.find((frame) => frame.event === 'sessionState').payload.wire).ok, true);
  snapshot = { ...snapshot, items: [...snapshot.items, { id: 'two', text: 'new answer' }] };
  const patch = replacement.sessionStateEncoders.get('session').encode(snapshot);
  assert.deepEqual(decoder.decode(patch).snapshot, snapshot);
  const changed = await sync(makeState());
  assert.ok(changed.frames.some((frame) => frame.payload.frame?.event === 'sessionState'));
  assert.ok(
    changed.frames.some((frame) => !Object.hasOwn(frame.payload, 'frame')),
    'unchanged catalogs still reuse bytes'
  );
  const legacy = await sync(makeState(), { offer: undefined, finish() {} });
  assert.ok(legacy.frames.every((frame) => frame.event !== 'viewBaseline'));
  const failed = makeState();
  await assert.rejects(
    registerAndSynchronizeRelayViews(
      host,
      'client',
      failed,
      [['session'], { version: 1, keys: [] }],
      () => true,
      async () => {
        throw new Error('socket failed');
      }
    ),
    /socket failed/
  );
  assert.equal(failed.syncing, false);
});
