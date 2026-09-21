import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_COMPUTER_ELEMENT_TEXT_CHARS, normalizeElementRecords } from './element-records.ts';

test('an element label identifies a control instead of carrying a whole message body', () => {
  const body = '사'.repeat(4_000);
  const [element] = normalizeElementRecords([
    { mark: 1, ref: 'uia:1', role: 'text', name: body, value: body, x: 1, y: 2 },
  ]);
  assert.equal(element.name.length, MAX_COMPUTER_ELEMENT_TEXT_CHARS + 1);
  assert.ok(element.name.endsWith('…'));
  assert.equal(element.value.length, MAX_COMPUTER_ELEMENT_TEXT_CHARS + 1);
  // Everything a later command addresses the element by is untouched.
  assert.equal(element.ref, 'uia:1');
  assert.equal(element.role, 'text');
  assert.equal(element.x, 1);
});

test('ordinary labels pass through unchanged', () => {
  const [element] = normalizeElementRecords([{ mark: 1, ref: 'uia:1', name: '저장(S)', value: 'round1.txt' }]);
  assert.equal(element.name, '저장(S)');
  assert.equal(element.value, 'round1.txt');
});
