// The comparison rule of the live Stop test (remote-protocol-chat-abort-compare.mjs) and the two recordings it computes from.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonical, runOwnPaths, varyingPaths } from './remote-protocol-chat-abort-compare.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('the two recordings of Node hold the same cases', () => {
  assert.deepEqual(read('./remote-protocol-chat-abort.rerecorded.json').cases.map((c) => c.name), read('./remote-protocol-chat-abort.recorded.json').cases.map((c) => c.name));
});

test('a run-own value is exempted at its path only, not wherever its key name recurs', () => {
  const a = { items: [{ id: 'it_1', kind: 'user' }], row: { id: 'sess_a' } };
  const b = { items: [{ id: 'it_2', kind: 'user' }], row: { id: 'sess_a' } };
  assert.deepEqual([...varyingPaths(a, b)], ['$.items[].id']);
  const runOwn = runOwnPaths([a, b]);
  assert.notDeepEqual(canonical({ ...a, row: { id: 'sess_b' } }, runOwn), canonical(a, runOwn), 'the row id did not vary in Node: it is compared as it is');
});

test('run-own strings are compared by relationship: two values that Node kept apart are not merged', () => {
  const runOwn = new Set(['$.items[].id', '$.end.finalAssistantId']);
  const node = { items: [{ id: 'n1' }, { id: 'n2' }], end: { finalAssistantId: 'n2' } };
  assert.deepEqual(canonical({ items: [{ id: 'c1' }, { id: 'c2' }], end: { finalAssistantId: 'c2' } }, runOwn), canonical(node, runOwn));
  assert.notDeepEqual(canonical({ items: [{ id: 'c1' }, { id: 'c1' }], end: { finalAssistantId: 'c1' } }, runOwn), canonical(node, runOwn), 'one id for two rows');
  assert.notDeepEqual(canonical({ items: [{ id: 'c1' }, { id: 'c2' }], end: { finalAssistantId: 'c1' } }, runOwn), canonical(node, runOwn), 'the end names the other row');
  assert.notDeepEqual(canonical({ items: [{ id: 1 }, { id: 'c2' }], end: { finalAssistantId: 'c2' } }, runOwn), canonical(node, runOwn), 'a number for a string');
});
