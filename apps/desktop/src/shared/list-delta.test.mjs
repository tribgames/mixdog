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
  assert.deepEqual(createKeyedListDeltaDecoder().decode(transmitted(encoder.encode(next))),
    { ok: true, items: next });
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
