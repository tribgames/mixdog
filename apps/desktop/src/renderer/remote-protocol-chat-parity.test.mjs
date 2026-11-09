// The comparison of remote-protocol-chat-parity.mjs sees every kind of difference: a changed time, a changed or extra field, a missing row, a reorder.
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

const after = (action) => ({
  nodeRoster: node.steps.find((s) => s.name === `action:${action}`).roster,
  phone: project(live.steps.find((s) => s.name === action).listed.data),
});
const edit = (rows, title, change) => rows.map((row) => (row.title === title ? change(row) : row));
const seen = (differences, path) => differences.some((d) => d === path || d.startsWith(`${path}:`));

test('a changed time on any row is a difference', () => {
  const { nodeRoster, phone } = after('turns');
  const base = parity.classify(nodeRoster, phone);
  for (const field of ['createdAt', 'updatedAt', 'activityAt']) {
    const got = parity.classify(nodeRoster, edit(phone, 'Title 4', (row) => ({ ...row, [field]: row[field] + 1 })));
    assert.ok(seen(got, `Title 4.${field}`) && !seen(base, `Title 4.${field}`), got.join());
  }
});

test('a favorite, read cursor or other field that differs from Node is a difference', () => {
  const { nodeRoster, phone } = after('turns');
  assert.ok(seen(parity.classify(nodeRoster, edit(phone, 'Title 1', (row) => ({ ...row, favorite: true }))), 'Title 1.favorite'));
  assert.ok(seen(parity.classify(nodeRoster, edit(phone, 'Title 2', (row) => ({ ...row, favorite: false }))), 'Title 2.favorite'));
  const cursor = parity.classify(nodeRoster, edit(phone, 'Title 1', (row) => ({ ...row, readMessageCount: 7, readRevision: 9 })));
  assert.ok(seen(cursor, 'Title 1.readMessageCount') && seen(cursor, 'Title 1.readRevision'), cursor.join());
  assert.ok(seen(parity.classify(nodeRoster, edit(phone, 'Title 3', (row) => ({ ...row, classification: 'task' }))), 'Title 3.classification'));
  assert.ok(seen(parity.classify(nodeRoster, edit(phone, 'Title 2', (row) => ({ ...row, cwd: 'D:\\elsewhere' }))), 'Title 2.cwd'));
});

test('a missing row and a reorder are differences', () => {
  const { nodeRoster, phone } = after('turns');
  assert.ok(parity.classify(nodeRoster, phone.slice(1)).includes(`${phone[0].title}.row`));
  const at = (title) => phone.findIndex((row) => row.title === title);
  const swapped = [...phone];
  [swapped[at('Title 3')], swapped[at('Title 4')]] = [swapped[at('Title 4')], swapped[at('Title 3')]];
  assert.ok(parity.classify(nodeRoster, swapped).includes('order'));
});
