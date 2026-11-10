// The comparison of remote-protocol-chat-parity.mjs sees every kind of difference: a changed time, a changed or extra field, a missing row, a reorder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { createParity } from './remote-protocol-chat-parity.mjs';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

const live = verifiedFixture('live').recordings[0];
const node = verifiedFixture('roster').recordings[0];
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = (rows) => summariesOfThreadRows(plain(rows));
const parity = createParity({ live, node, project });

const after = (action) => ({
  nodeRoster: node.steps.find((s) => s.name === `action:${action}`).roster,
  phone: project(live.steps.find((s) => s.name === action).listed.data),
});
const edit = (rows, title, change) => rows.map((row) => (row.title === title ? change(row) : row));
// A difference is `<index>:<title>.<field>`; `path` names it by title and field.
const seen = (differences, path) => differences.some((d) => { const bare = d.slice(d.indexOf(':') + 1); return bare === path || bare.startsWith(`${path}:`); });

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
  assert.ok(seen(parity.classify(nodeRoster, phone.slice(0, -1)), `${phone.at(-1).title}.row`));
  const at = (title) => phone.findIndex((row) => row.title === title);
  const swapped = [...phone];
  [swapped[at('Title 3')], swapped[at('Title 4')]] = [swapped[at('Title 4')], swapped[at('Title 3')]];
  assert.ok(seen(parity.classify(nodeRoster, swapped), 'Title 3.id'), 'the rows at swapped positions differ by identity');
});

test('rows are compared by position: two rows of one title are not merged', () => {
  const { nodeRoster, phone } = after('turns');
  const titled = (rows) => rows.map((row) => ({ ...row, title: 'same' }));
  const node = titled(nodeRoster);
  const base = parity.classify(node, titled(phone));
  const changed = titled(phone).map((row, index) => (index === 0 ? { ...row, id: 'sess_other', classification: row.classification === 'task' ? 'project' : 'task', cwd: 'D:\\elsewhere' } : row));
  const got = parity.classify(node, changed);
  for (const field of ['id', 'classification', 'cwd']) {
    const at = (differences) => differences.some((d) => d.startsWith(`0:same.${field}:`));
    assert.ok(at(got) && !at(base), `${field}: ${got.join()}`);
  }
});
