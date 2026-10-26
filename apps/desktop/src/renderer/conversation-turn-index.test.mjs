import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnIndexer } from './conversation-turn-index.ts';
import { linkedLocalPaths } from './markdown-plugins.ts';
import { visualizedTargets, visualizeTurnEndAt } from './visualize-card-model.ts';

// The per-turn reads the row renderer made before the index existed, kept
// verbatim as the reference the index must agree with.
function referenceTurnEndedAt(rows, turnKey) {
  let at = 0;
  for (const row of rows) {
    if (row.turnKey !== turnKey) continue;
    if (row._tag === 'ToolActivity') at = Math.max(at, visualizeTurnEndAt(row.items));
    else if ('item' in row && row.item) {
      at = Math.max(at, Number(row.item.completedAt ?? row.item.at ?? row.item.startedAt) || 0);
    }
  }
  return at;
}

function referenceReplyText(rows, turnKey) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row._tag === 'AssistantPart' && row.turnKey === turnKey && row.item.kind === 'assistant') {
      return String(row.item.text || '');
    }
  }
  return '';
}

function referenceSurfacedBefore(rows, turnKey) {
  const first = rows.findIndex((row) => row.turnKey === turnKey);
  const surfaced = new Set();
  for (const row of first < 0 ? rows : rows.slice(0, first)) {
    if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') {
      for (const path of linkedLocalPaths(String(row.item.text || ''))) surfaced.add(path);
    } else if (row._tag === 'ToolActivity') {
      for (const target of visualizedTargets(row.items)) surfaced.add(target);
    }
  }
  return [...surfaced];
}

function referenceChangesAndVisualized(rows, turnKey) {
  const found = rows.find(
    (other) => other.turnKey === turnKey && (other._tag === 'AssistantPart' || other._tag === 'Error') && other.turnChanges
  );
  const changes = found ? found.turnChanges : undefined;
  const items = rows.flatMap((other) => (other._tag === 'ToolActivity' && other.turnKey === turnKey ? other.items : []));
  return { changes, visualized: changes ? visualizedTargets(items) : undefined };
}

const open = (id, target, tab, at, done = true) => ({
  id,
  kind: 'tool',
  name: 'visualize',
  args: { action: 'open', input: { targets: [target] } },
  ...(done ? { result: `Prepared ${target} (html) as tab ${tab} (version 1).`, completedAt: at + 1 } : {}),
  startedAt: at,
});
const userRow = (turnKey, at) => ({
  _tag: 'UserMessage',
  key: `u${at}`,
  turnKey,
  item: { kind: 'user', id: `u${at}`, text: 'go', at },
});
const replyRow = (turnKey, text, at, turnChanges) => ({
  _tag: 'AssistantPart',
  key: `a${at}`,
  turnKey,
  item: { kind: 'assistant', id: `a${at}`, text, at },
  ...(turnChanges ? { turnChanges } : {}),
});
const toolRow = (turnKey, key, items) => ({ _tag: 'ToolActivity', key, turnKey, items });

const changes1 = { checkpointId: 'cp1', boundary: 'd1', trailing: true };
const changes2 = { checkpointId: 'cp2', boundary: 'd2', trailing: true };
const changes3 = { checkpointId: 'cp3', boundary: 'd3', trailing: true };

const transcript = () => [
  userRow('t1', 1),
  toolRow('t1', 'tool1', [open('o1', 'site/a.html', 'v1', 2)]),
  replyRow('t1', 'Wrote [notes](docs/one.md).', 4),
  userRow('t2', 10),
  toolRow('t2', 'tool2', [open('o2', 'site/b.html', 'v2', 11), open('o3', 'site/c.html', 'v3', 12, false)]),
  replyRow('t2', 'Draft [two](docs/two.md).', 14),
  toolRow('t2', 'tool3', [open('o4', 'site/a.html', 'v1', 15), open('o5', 'site/d.html', 'v4', 16)]),
  replyRow('t2', 'Final [two](docs/two.md) and [one](docs/one.md).', 18, changes2),
  userRow('t3', 20),
  { _tag: 'Error', key: 'e1', turnKey: 't3', item: { kind: 'error', id: 'e1', text: 'x', at: 21 }, failures: [], turnChanges: changes3 },
  toolRow('t3', 'tool4', [open('o6', 'site/e.html', 'v5', 22)]),
  userRow('t4', 30),
  replyRow('t4', 'No changes here.', 31),
  { ...replyRow('t1', 'late part of the first turn', 40, changes1), key: 'late' },
];

test('the index agrees with the per-turn reads it replaced, turn by turn', () => {
  const { turnIndexOf } = createTurnIndexer(visualizedTargets);
  const rows = transcript();
  const index = turnIndexOf(rows);
  assert.deepEqual([...index.keys()], ['t1', 't2', 't3', 't4']);
  for (const [turnKey, turn] of index) {
    const { changes, visualized } = referenceChangesAndVisualized(rows, turnKey);
    assert.deepEqual(turn.surfacedBefore, referenceSurfacedBefore(rows, turnKey), `${turnKey} surfacedBefore`);
    assert.equal(turn.replyText, referenceReplyText(rows, turnKey), `${turnKey} replyText`);
    assert.equal(turn.endedAt, referenceTurnEndedAt(rows, turnKey), `${turnKey} endedAt`);
    assert.equal(turn.changes, changes, `${turnKey} changes`);
    if (changes) assert.deepEqual(turn.visualized(), visualized, `${turnKey} visualized`);
  }
  // Pin the transcript's own shape so the comparison above is not vacuous.
  assert.deepEqual(index.get('t1').surfacedBefore, []);
  assert.deepEqual(index.get('t2').surfacedBefore, ['site/a.html', 'docs/one.md']);
  assert.deepEqual(index.get('t4').surfacedBefore, [
    'site/a.html',
    'docs/one.md',
    'site/b.html',
    'docs/two.md',
    'site/d.html',
    'site/e.html',
  ]);
  assert.equal(index.get('t2').replyText, 'Final [two](docs/two.md) and [one](docs/one.md).');
  assert.equal(index.get('t2').changes, changes2);
  assert.equal(index.get('t1').changes, changes1, 'a later row of the turn still carries its changes');
  assert.deepEqual(index.get('t2').visualized(), ['site/b.html', 'site/a.html', 'site/d.html']);
});

test('the index is built once per rows array, and a group is read once across arrays', () => {
  const reads = [];
  const { turnIndexOf } = createTurnIndexer((items) => {
    reads.push(items);
    return visualizedTargets(items);
  });
  const rows = transcript();
  const toolRows = rows.filter((row) => row._tag === 'ToolActivity');
  const first = turnIndexOf(rows);
  assert.equal(reads.length, toolRows.length, 'one read per tool group, in the single pass');
  for (let render = 0; render < 5; render += 1) {
    assert.equal(turnIndexOf(rows), first, 'repeated renders of the same rows share the index');
  }
  assert.equal(reads.length, toolRows.length, 'repeated renders read nothing again');

  const turn = first.get('t2');
  assert.equal(turn.visualized(), turn.visualized(), 'a turn reads its visualized targets once');
  assert.equal(reads.length, toolRows.length + 1);

  const longer = [...rows, userRow('t5', 50)];
  const grown = turnIndexOf(longer);
  assert.notEqual(grown, first, 'new rows get a new index');
  assert.equal(reads.length, toolRows.length + 1, 'unchanged tool groups are not read again');
  assert.deepEqual(grown.get('t5').surfacedBefore, referenceSurfacedBefore(longer, 't5'));
});

test('turns that surfaced nothing new share one surfacedBefore array', () => {
  const { turnIndexOf } = createTurnIndexer(visualizedTargets);
  const rows = [userRow('a', 1), userRow('b', 2), replyRow('b', 'See [x](x.md).', 3), userRow('c', 4)];
  const index = turnIndexOf(rows);
  assert.equal(index.get('a').surfacedBefore, index.get('b').surfacedBefore);
  assert.notEqual(index.get('b').surfacedBefore, index.get('c').surfacedBefore);
  assert.deepEqual(index.get('c').surfacedBefore, ['x.md']);
});
