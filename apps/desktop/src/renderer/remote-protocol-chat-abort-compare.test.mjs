// The comparison rule of the live Stop test (remote-protocol-chat-abort-compare.mjs) and the two recordings it computes from.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonical, runOwnPaths, varyingPaths } from './remote-protocol-chat-abort-compare.mjs';
import { differences, variantsOf, verifiedRecordings } from './remote-protocol-chat-abort-fixture.mjs';

const { manifest, recordings } = verifiedRecordings();
const names = recordings[0].cases.map((c) => c.name);
const sidesOf = (name) => recordings.map((r) => r.cases.find((c) => c.name === name).node);

test('every recording holds the same cases, and the manifest declares the free points', () => {
  for (const r of recordings) assert.deepEqual(r.cases.map((c) => c.name), names);
  assert.deepEqual(Object.keys(manifest.freePoints).sort(), ['rows', 'snapshots']);
});

// The cases where Node's own recordings disagree on what the rule holds exact or last are reported: the manifest names them, and
// names exactly those.
test('the cases where Node disagrees with itself are the ones the manifest reports', () => {
  const found = Object.fromEntries(names.map((name) => [name, variantsOf(sidesOf(name))]).filter(([, v]) => v.length));
  assert.deepEqual(found, manifest.nodeVariants);
});

// Mutations of a Node recording that the rule must reject (it is not too loose).
const name = 'running-with-output';
const [held, ...rest] = sidesOf(name);
const mutate = (fn) => { const side = structuredClone(held); fn(side); return differences(side, rest); };
test('a mutated recording is rejected: a row with another case\'s content', () => {
  const other = sidesOf('running-keep-prompt')[0].stream.find((e) => e.kind === 'row');
  assert.notDeepEqual(mutate((s) => { s.stream.splice(s.stream.findIndex((e) => e.kind === 'row'), 0, structuredClone(other)); }), []);
});
test('a mutated recording is rejected: a snapshot Node never published', () => {
  assert.notDeepEqual(mutate((s) => { const at = s.stream.findIndex((e) => e.kind === 'state'); s.stream.splice(at + 1, 0, { ...structuredClone(s.stream[at]), snapshot: { ...s.stream[at].snapshot, busy: !s.stream[at].snapshot.busy, model: 'half-applied' } }); }), []);
});
test('a mutated recording is rejected: the Stop\'s reply moved before the snapshot that carries its cause', () => {
  assert.notDeepEqual(mutate((s) => { const at = s.stream.findIndex((e) => e.kind === 'reply' && e.method === 'abortSession'); const [reply] = s.stream.splice(at, 1); s.stream.splice(s.stream.findIndex((e) => e.kind === 'reply') + 1, 0, reply); }), []);
});
test('a mutated recording is rejected: the last snapshot dropped', () => {
  assert.notDeepEqual(mutate((s) => { s.stream.splice(s.stream.findLastIndex((e) => e.kind === 'state'), 1); }), []);
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
