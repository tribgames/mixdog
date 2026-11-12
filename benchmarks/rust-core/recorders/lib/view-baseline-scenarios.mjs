// The cases of apps/desktop/src/shared/remote-view-baseline.test.mjs (b6f10295a), as functions of the modules they drive (the recorder
// passes the Node tree's, the desktop's replay the product's). Each returns what the test asserted on, whole: the offers, the restored
// frames, the frames a reconnecting phone is sent and what its decoder made of them.
import { createHash } from 'node:crypto';

const baseline = (text) => {
  const frame = { event: 'sessionState', payload: { sessionId: 'session', text } };
  return { key: createHash('sha256').update(JSON.stringify(frame)).digest('hex'), frame };
};
const outcome = (fn) => {
  try {
    return { returned: fn() };
  } catch (error) {
    return { threw: error.message };
  }
};

export function viewBaselineScenarios({ createRemoteViewBaselineCache, readViewBaselineOffer, registerAndSynchronizeRelayViews, createRemoteStateLane, createSnapshotDeltaDecoder, createKeyedListDeltaEncoder }) {
  return {
    'retained baselines are bounded, pinned during recovery and isolated from consumer mutation': async () => {
      let now = 0;
      const a = baseline('a'.repeat(120));
      const b = baseline('b'.repeat(120));
      const cache = createRemoteViewBaselineCache(JSON.stringify(a.frame).length * 2 + 8, () => now);
      cache.restore(a).payload.text = 'mutated by consumer';
      const first = cache.begin();
      cache.restore(b); // Evicts a from the next offer, but not from this request.
      const pinnedRestore = cache.restore({ key: a.key }).payload.text === a.frame.payload.text;
      first.finish();
      const afterFinish = outcome(() => cache.restore({ key: a.key }));
      const second = cache.begin();
      const secondKeys = second.offer.keys;
      first.finish(); // An obsolete request cannot release a replacement's pins.
      const bRestored = cache.restore({ key: b.key });
      second.finish();
      now = 300_001;
      const expiredKeys = cache.begin().offer.keys;
      cache.restore(a);
      cache.begin();
      cache.clear();
      const afterClear = outcome(() => cache.restore({ key: a.key }));
      return {
        keys: { a: a.key, b: b.key },
        pinnedRestore,
        afterFinish,
        secondKeys,
        bRestored,
        expiredKeys,
        afterClear,
        invalidKey: readViewBaselineOffer({ version: 1, keys: ['invalid'] }),
        wrongVersion: readViewBaselineOffer({ version: 2, keys: [] }),
        tooManyKeys: readViewBaselineOffer({ version: 1, keys: Array(133).fill(a.key) }),
      };
    },
    'successful retained references renew expiry without reviving evicted or cleared entries': async () => {
      let now = 0;
      const a = baseline('a'.repeat(120));
      const b = baseline('b'.repeat(120));
      const cache = createRemoteViewBaselineCache(JSON.stringify(a.frame).length * 2 + 8, () => now);
      cache.restore(a);
      now = 240_000;
      const reference = cache.begin();
      const referenced = cache.restore({ key: a.key });
      reference.finish();
      now = 300_001;
      const renewed = cache.begin();
      const renewedKeys = renewed.offer.keys;
      renewed.finish();
      now = 540_001;
      const expired = cache.begin();
      const expiredKeys = expired.offer.keys;
      expired.finish();
      cache.restore(a);
      const pinned = cache.begin();
      cache.restore(b);
      const pinnedRestore = cache.restore({ key: a.key });
      pinned.finish();
      const retained = cache.begin();
      const retainedKeys = retained.offer.keys;
      cache.clear();
      const afterClear = outcome(() => cache.restore({ key: b.key }));
      retained.finish();
      return { keys: { a: a.key, b: b.key }, referenced, renewedKeys, expiredKeys, pinnedRestore, retainedKeys, afterClear, afterLastFinish: cache.begin().offer.keys };
    },
    'reconnect references only identical full baselines and rebuilds a usable delta decoder': async () => {
      let snapshot = { sessionId: 'session', streamingTail: null, items: [{ id: 'one', text: 'unchanged transcript '.repeat(500) }] };
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
          await registerAndSynchronizeRelayViews(host, 'client', state, [['session'], offer.offer], () => true, async (frame) => {
            frames.push(frame);
            restored.push(frame.event === 'viewBaseline' ? cache.restore(frame.payload) : frame);
          });
          return { frames, restored };
        } finally {
          offer.finish();
        }
      };
      const first = await sync(makeState());
      const replacement = makeState();
      const repeated = await sync(replacement);
      const decoder = createSnapshotDeltaDecoder();
      const decodedBaseline = decoder.decode(repeated.restored.find((frame) => frame.event === 'sessionState').payload.wire).ok;
      snapshot = { ...snapshot, items: [...snapshot.items, { id: 'two', text: 'new answer' }] };
      const patch = replacement.sessionStateEncoders.get('session').encode(snapshot);
      const decodedPatch = decoder.decode(patch).snapshot;
      const changed = await sync(makeState());
      const legacy = await sync(makeState(), { offer: undefined, finish() {} });
      const failed = makeState();
      const socketFailure = await registerAndSynchronizeRelayViews(host, 'client', failed, [['session'], { version: 1, keys: [] }], () => true, async () => {
        throw new Error('socket failed');
      }).then(() => null, (error) => error.message);
      return {
        firstFrameCount: first.frames.length,
        firstFrames: first.frames,
        repeatedFrames: repeated.frames,
        repeatedBytesUnderTenthOfFirst: JSON.stringify(repeated.frames).length < JSON.stringify(first.frames).length / 10,
        restoredEqualsFirst: JSON.stringify(repeated.restored) === JSON.stringify(first.restored),
        decodedBaseline,
        patch,
        decodedPatchEqualsSnapshot: JSON.stringify(decodedPatch) === JSON.stringify(snapshot),
        changedFrames: changed.frames.map((frame) => ({ event: frame.event, hasFrame: Object.hasOwn(frame.payload, 'frame'), innerEvent: frame.payload.frame?.event ?? null })),
        legacyEvents: legacy.frames.map((frame) => frame.event),
        socketFailure,
        syncingAfterFailure: failed.syncing,
      };
    },
  };
}
