import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshotStateMailbox } from './snapshot-state-mailbox.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';

test('unchanged snapshots release their slot without crossing the wire or stranding the next update', () => {
  const delivered = [];
  const decoder = createSnapshotDeltaDecoder();
  const mailbox = createSnapshotStateMailbox((sequence, wire) => {
    const decoded = decoder.decode(structuredClone(wire));
    assert.equal(decoded.ok, true);
    delivered.push({ sequence, snapshot: decoded.snapshot });
  });
  const first = { sessionId: 'session', items: [], busy: false };
  mailbox.publish(first);
  // This duplicate waits behind the first real frame. Its slot must be
  // acknowledged locally after the receiver acknowledges that first frame.
  mailbox.publish({ ...first });
  mailbox.acknowledge(delivered[0].sequence);
  mailbox.publish({ ...first });
  assert.equal(delivered.length, 1);
  const next = { ...first, items: [{ id: 'next', text: 'after cancel' }], busy: true };
  mailbox.publish(next);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.at(-1).snapshot.items, next.items);
  mailbox.acknowledge(delivered.at(-1).sequence);
  mailbox.publish({ ...next });
  mailbox.publish({ ...next, busy: false });
  assert.equal(delivered.length, 3);
  assert.equal(delivered.at(-1).snapshot.busy, false);
  mailbox.clear();
});

test('resync sends unchanged content to a receiver with no baseline even while an old frame awaits acknowledgement', () => {
  let decoder = createSnapshotDeltaDecoder();
  const delivered = [];
  const mailbox = createSnapshotStateMailbox((sequence, wire) => {
    const decoded = decoder.decode(structuredClone(wire));
    assert.equal(decoded.ok, true);
    delivered.push({ sequence, snapshot: decoded.snapshot });
  });
  const snapshot = { sessionId: 'session', items: [{ id: 'kept', text: 'kept' }], busy: true };
  mailbox.publish(snapshot);
  const lostAck = delivered[0].sequence;
  decoder = createSnapshotDeltaDecoder();
  mailbox.reset(snapshot);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.at(-1).snapshot.items, snapshot.items);
  mailbox.acknowledge(lostAck);
  mailbox.publish({ ...snapshot, busy: false });
  assert.equal(delivered.length, 2, 'an old acknowledgement cannot release the recovery frame');
  mailbox.acknowledge(delivered[1].sequence);
  assert.equal(delivered.length, 3);
  assert.equal(delivered.at(-1).snapshot.busy, false);
  mailbox.clear();
});
