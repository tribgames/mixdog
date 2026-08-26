import assert from 'node:assert/strict';
import test from 'node:test';

import { record, rows } from './record-utils.ts';

test('record normalization accepts plain objects and rejects non-record values', () => {
  const source = { id: 'row-a' };
  assert.strictEqual(record(source), source);
  assert.deepEqual(record(null), {});
  assert.deepEqual(record([]), {});
  assert.deepEqual(record('row-a'), {});
});

test('row normalization preserves order and normalizes invalid entries', () => {
  const source = { id: 'row-a' };
  assert.deepEqual(rows([source, null, 'row-b']), [source, {}, {}]);
  assert.deepEqual(rows(source), []);
});
