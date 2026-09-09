import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  isNoDelta,
  markCompactWire,
} from './state-delta.ts';

for (const compact of [false, true]) {
  for (const changeBusy of [false, true]) {
    test(`cancelled suffixes and empty transcripts survive the wire (compact=${compact}, busy change=${changeBusy})`, () => {
      const encoder = createSnapshotDeltaEncoder({ compact });
      const decoder = createSnapshotDeltaDecoder();
      const retained = { id: 'retained', kind: 'assistant', text: 'previous answer' };
      const cancelled = { id: 'cancelled', kind: 'user', text: 'restore this prompt' };
      const nextPrompt = { id: 'next', kind: 'user', text: 'new request' };
      const deliver = (snapshot) => {
        const encoded = encoder.encode(snapshot);
        assert.equal(isNoDelta(encoded), false, 'a transcript change must be delivered');
        const wire = JSON.parse(JSON.stringify(encoded));
        if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
        const decoded = decoder.decode(wire);
        assert.equal(decoded.ok, true);
        assert.deepEqual(decoded.snapshot.items, snapshot.items);
      };
      const first = { sessionId: 'session', items: [retained, cancelled], busy: true };
      deliver(first);
      const restored = { ...first, items: [retained], busy: !changeBusy };
      deliver(restored);
      deliver({ ...restored, items: [retained, nextPrompt], busy: true });
      deliver({ ...restored, items: [] });
      // A new turn after clearing must not splice onto the cancelled history.
      deliver({ ...restored, items: [nextPrompt], busy: true });
    });
  }
}
