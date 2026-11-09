// The gap classification of remote-protocol-chat-parity.mjs is exact: the differences mixdogd's rows have today are classified as the named
// Rust gaps, and a difference that merely looks like one (a wrong value where a field is only missing, a time change on a row or action the gap
// does not explain, an unexplained reorder) is NOT a gap and fails the replays.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { createParity } from './remote-protocol-chat-parity.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const live = read('./remote-protocol-chat-live.recorded.json');
const node = read('./remote-protocol-chat-roster.recorded.json');
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = (rows) => summariesOfThreadRows(plain(rows));
const parity = createParity({ live, node, project });

/** What the phone publishes after `action`, and the roster Node's phone published for it. */
const after = (action) => ({
  nodeRoster: node.steps.find((s) => s.name === `action:${action}`).roster,
  phone: project(live.steps.find((s) => s.name === action).listed.data),
});
const edit = (rows, title, change) => rows.map((row) => (row.title === title ? change(row) : row));

test('the differences mixdogd has today are exactly the named gaps (none is unexplained)', () => {
  for (const action of node.manifest.actions) {
    const { nodeRoster, phone } = after(action);
    const { gaps, unexpected } = parity.classify(nodeRoster, phone);
    assert.deepEqual(unexpected, [], action);
    assert.ok(gaps.includes('Title 1.readMessageCount') && gaps.includes('Title 2.favorite') && gaps.includes('order'), action);
  }
  assert.deepEqual(parity.timeOrderBreaks().unexpected, []);
});

test('a time difference on a row the rename gap does not explain fails (Title 4 activityAt moved)', () => {
  const { nodeRoster, phone } = after('turns');
  const { unexpected } = parity.classify(nodeRoster, edit(phone, 'Title 4', (row) => ({ ...row, activityAt: row.activityAt + 1 })));
  assert.ok(unexpected.includes('Title 4.activityAt'), unexpected.join());
});

test('a time change on a row an action has rewritten fails (Title 0 updatedAt after its turn)', () => {
  const { nodeRoster, phone } = after('turns');
  const { unexpected } = parity.classify(nodeRoster, edit(phone, 'Title 0', (row) => ({ ...row, updatedAt: row.updatedAt + 1 })));
  assert.ok(unexpected.includes('Title 0.updatedAt'), unexpected.join());
});

test('a favorite the core sets where Node has none fails (Title 1 favorite present)', () => {
  const { nodeRoster, phone } = after('turns');
  const { unexpected } = parity.classify(nodeRoster, edit(phone, 'Title 1', (row) => ({ ...row, favorite: true })));
  assert.ok(unexpected.includes('Title 1.favorite'), unexpected.join());
});

test('a wrong present favorite or cursor fails: the gap is the missing field, not a different value', () => {
  const { nodeRoster, phone } = after('turns');
  const wrongFavorite = parity.classify(nodeRoster, edit(phone, 'Title 2', (row) => ({ ...row, favorite: false })));
  assert.ok(wrongFavorite.unexpected.includes('Title 2.favorite'), wrongFavorite.unexpected.join());
  const wrongCursor = parity.classify(nodeRoster, edit(phone, 'Title 1', (row) => ({ ...row, readMessageCount: 7, readRevision: 9 })));
  assert.ok(wrongCursor.unexpected.includes('Title 1.readMessageCount') && wrongCursor.unexpected.includes('Title 1.readRevision'), wrongCursor.unexpected.join());
});

test('a reorder the time gaps do not explain fails (two untouched rows swapped)', () => {
  const { nodeRoster, phone } = after('turns');
  const at = (title) => phone.findIndex((row) => row.title === title);
  const swapped = [...phone];
  [swapped[at('Title 3')], swapped[at('Title 4')]] = [swapped[at('Title 4')], swapped[at('Title 3')]];
  const { unexpected } = parity.classify(nodeRoster, swapped);
  assert.ok(unexpected.includes('order'), unexpected.join());
});

test('fork placement is only a gap for the fork, and only as the task workspace', () => {
  const { nodeRoster, phone } = after('turns');
  const other = parity.classify(nodeRoster, edit(phone, 'Title 3', (row) => ({ ...row, classification: 'task' })));
  assert.ok(other.unexpected.includes('Title 3.classification'), other.unexpected.join());
  const wrongFolder = parity.classify(nodeRoster, edit(phone, 'Title 2', (row) => ({ ...row, cwd: 'D:\\elsewhere' })));
  assert.ok(wrongFolder.unexpected.includes('Title 2.cwd'), wrongFolder.unexpected.join());
});
