import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyedListDeltaDecoder, createKeyedListDeltaEncoder, isNoListDelta } from './list-delta.ts';

const transmitted = (wire) => JSON.parse(JSON.stringify(wire));

test('unchanged list publications send nothing and the next real patch still decodes', () => {
  const encoder = createKeyedListDeltaEncoder((row) => row.id);
  const decoder = createKeyedListDeltaDecoder();
  const rows = [{ id: 'a', title: 'retained title', working: false }];
  assert.equal(decoder.decode(transmitted(encoder.encode(rows))).ok, true);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(isNoListDelta(encoder.encode(rows.map((row) => ({ ...row })))), true);
  }
  const next = [{ ...rows[0], working: true }];
  assert.deepEqual(decoder.decode(transmitted(encoder.encode(next))), { ok: true, items: next });
  encoder.reset();
  assert.deepEqual(createKeyedListDeltaDecoder().decode(transmitted(encoder.encode(next))), { ok: true, items: next });
});

test('a reused row mutated in place is compared with the transmitted value', () => {
  const encoder = createKeyedListDeltaEncoder((row) => row.id);
  const decoder = createKeyedListDeltaDecoder();
  const rows = [{ id: 'a', preview: 'retained '.repeat(100), working: false }];
  decoder.decode(transmitted(encoder.encode(rows)));
  rows[0].working = true;
  const wire = encoder.encode(rows);
  assert.equal(isNoListDelta(wire), false);
  assert.deepEqual(decoder.decode(transmitted(wire)).items, rows);
});

test('a catch-up onto seeded rows ends where a baseline would, and later patches apply', () => {
  const held = ['a', 'b', 'c', 'd'].map((id) => [id, { id, title: id }]);
  const now = [{ id: 'n', title: 'new' }, { id: 'a', title: 'a' }, { id: 'c', title: 'changed' }, { id: 'd', title: 'd' }];
  const encoder = createKeyedListDeltaEncoder((row) => row.id);
  const revision = encoder.adopt(now);
  const reference = createKeyedListDeltaEncoder((row) => row.id);
  reference.encode(now);
  assert.deepEqual(encoder.resumePoint(), reference.resumePoint());

  const decoder = createKeyedListDeltaDecoder();
  const wire = {
    __listCatch: { revision, upsert: [['n', now[0]], ['c', now[2]]], removed: ['b'], place: [0, 2], count: 4, digest: '' },
  };
  assert.equal(decoder.decode(transmitted(wire)).ok, false, 'nothing to catch up onto');
  decoder.seed(held);
  assert.deepEqual(decoder.decode(transmitted(wire)), { ok: true, items: now });
  const next = [...now, { id: 'e', title: 'e' }];
  assert.deepEqual(decoder.decode(transmitted(encoder.encode(next))), { ok: true, items: next });

  // A count that does not add up is refused, never guessed at.
  decoder.seed(held);
  assert.equal(decoder.decode(transmitted({ __listCatch: { ...wire.__listCatch, count: 5 } })).ok, false);
  // Seeded rows carry no revision: an ordinary patch never applies to them.
  decoder.seed(held);
  assert.equal(decoder.decode(transmitted(encoder.encode(now))).ok, false);
});
