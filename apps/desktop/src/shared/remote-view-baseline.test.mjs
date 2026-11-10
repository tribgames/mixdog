import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRemoteViewBaselineCache, readViewBaselineOffer } from './remote-view-baseline.ts';

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

// The reconnect case drove the Node relay's view synchronization (remote-view-sync.ts, remote-state-lane.ts), which went with the
// relay; the core now answers a phone's baseline offer (uncovered-cases.md).
