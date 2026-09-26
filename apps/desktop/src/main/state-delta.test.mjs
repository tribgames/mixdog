import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  isNoDelta,
  markCompactWire,
  reconcileSessionProjection,
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

const row = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(40) });
const received = (encoded, compact) => {
  const wire = JSON.parse(JSON.stringify(encoded));
  if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
  return wire;
};

for (const compact of [false, true]) {
  test(`an older-history page travels as the revealed rows only (compact=${compact})`, () => {
    const encoder = createSnapshotDeltaEncoder({ compact, prepend: true });
    const decoder = createSnapshotDeltaDecoder();
    const held = ['r0', 'r1', 'r2', 'r3'].map(row);
    const first = { sessionId: 'session', items: held, transcriptHasOlder: true };
    const baseline = decoder.decode(received(encoder.encode(first), compact));
    assert.equal(baseline.ok, true);
    const heldOnClient = baseline.snapshot.items;

    const revealed = ['h0', 'h1', 'h2'].map(row);
    // The page lands together with a live append at the tail.
    const tail = row('t0');
    const paged = { ...first, items: [...revealed, ...held, tail] };
    const encoded = encoder.encode(paged);
    const patch = compact ? encoded.ip : encoded.__itemsPatch;
    assert.deepEqual(compact ? patch.h : patch.prepend, revealed, 'only the revealed rows travel');
    assert.equal(compact ? patch.p : patch.prefix, held.length, 'every held row is kept');
    assert.deepEqual(compact ? patch.a : patch.append, [tail]);
    assert.ok(JSON.stringify(encoded).length < JSON.stringify(paged).length * 0.6);

    const decoded = decoder.decode(received(encoded, compact));
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.snapshot.items, paged.items);
    // The rows already delivered stay the client's own objects.
    for (let index = 0; index < held.length; index += 1) {
      assert.equal(decoded.snapshot.items[revealed.length + index], heldOnClient[index]);
    }

    // The stream continues from the grown baseline.
    const next = encoder.encode({ ...paged, items: [...paged.items, row('t1')] });
    const appended = decoder.decode(received(next, compact));
    assert.equal(appended.ok, true);
    assert.deepEqual(
      appended.snapshot.items.map((item) => item.id),
      ['h0', 'h1', 'h2', 'r0', 'r1', 'r2', 'r3', 't0', 't1']
    );
  });

  test(`a peer that never announced prepend keeps receiving the whole list (compact=${compact})`, () => {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    const held = ['r0', 'r1'].map(row);
    decoder.decode(received(encoder.encode({ sessionId: 'session', items: held }), compact));
    const paged = { sessionId: 'session', items: [row('h0'), ...held] };
    const encoded = encoder.encode(paged);
    const patch = compact ? encoded.ip : encoded.__itemsPatch;
    assert.equal(compact ? patch.p : patch.prefix, 0);
    assert.equal((compact ? patch.a : patch.append).length, 3);
    assert.equal(Object.hasOwn(patch, compact ? 'h' : 'prepend'), false);
    assert.deepEqual(decoder.decode(received(encoded, compact)).snapshot.items, paged.items);
  });
}

test('a re-read stored window grown at its head keeps the held rows by identity', () => {
  const held = ['r0', 'r1', 'r2'].map(row);
  const previous = { sessionId: 'session', items: held, transcriptHasOlder: true };
  // A stored read parses a brand-new object graph.
  const reread = JSON.parse(JSON.stringify({ ...previous, items: [row('h0'), row('h1'), ...held] }));
  const merged = reconcileSessionProjection(previous, reread);
  assert.deepEqual(merged.items, reread.items);
  assert.equal(merged.items[0], reread.items[0]);
  for (let index = 0; index < held.length; index += 1) assert.equal(merged.items[2 + index], held[index]);
  // A held row that changed while the page was read is replaced, not kept.
  const settled = JSON.parse(JSON.stringify(reread));
  settled.items[4].text = 'settled';
  const changed = reconcileSessionProjection(previous, settled);
  assert.equal(changed.items[2], held[0]);
  assert.equal(changed.items[4].text, 'settled');
});
