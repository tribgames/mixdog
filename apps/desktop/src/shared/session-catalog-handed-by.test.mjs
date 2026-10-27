import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSessionCatalogRows, sessionCatalogRowsEqual } from './session-catalog.ts';

const rows = (handedBy) =>
  Array.from({ length: 2000 }, (_, index) => ({
    id: `sess_${index}`,
    title: `Session ${index}`,
    ...(index === 7 ? { handedBy: [...handedBy] } : {}),
  }));

test('an unchanged handedBy, rebuilt as a new array on each push, keeps the row and the catalog identical', () => {
  const current = rows(['bot_a']);
  const merged = mergeSessionCatalogRows(current, rows(['bot_a']));
  assert.equal(merged, current);
  assert.equal(merged[7], current[7]);
  assert.equal(sessionCatalogRowsEqual(current, rows(['bot_a'])), true);
});

test('a changed handedBy replaces only its row', () => {
  const current = rows(['bot_a']);
  for (const next of [['bot_b'], ['bot_a', 'bot_b'], []]) {
    const merged = mergeSessionCatalogRows(current, rows(next));
    assert.notEqual(merged, current);
    assert.notEqual(merged[7], current[7]);
    assert.equal(merged[8], current[8]);
  }
});
