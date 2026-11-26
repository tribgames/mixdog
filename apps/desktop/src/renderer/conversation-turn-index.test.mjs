import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnIndexer } from './conversation-turn-index.ts';
import { noteCarried } from './list-carry.ts';
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
    (other) =>
      other.turnKey === turnKey && (other._tag === 'AssistantPart' || other._tag === 'Error') && other.turnChanges
  );
  const changes = found ? found.turnChanges : undefined;
  const items = rows.flatMap((other) =>
    other._tag === 'ToolActivity' && other.turnKey === turnKey ? other.items : []
  );
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
  {
    _tag: 'Error',
    key: 'e1',
    turnKey: 't3',
    item: { kind: 'error', id: 'e1', text: 'x', at: 21 },
    failures: [],
    turnChanges: changes3,
  },
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

test('mid-turn queued, cancelled, and settled steers keep the open turn running and merge its tool rounds', () => {
  const { turnIndexOf } = createTurnIndexer(visualizedTargets);
  const gap = (turnKey, key) => ({ _tag: 'TurnGap', key, turnKey });
  const thinking = (turnKey, key = 'thinking') => ({ _tag: 'Thinking', key, turnKey });
  const steerRow = (turnKey, key, extra) => ({
    _tag: 'UserMessage',
    key,
    turnKey,
    item: { kind: 'user', id: key, text: 'actually check b too', ...extra },
  });
  const preOpen = open('o1', 'site/a.html', 'v1', 2);
  const postOpen = open('o2', 'site/b.html', 'v2', 8);

  // Queued mid-turn steer moves Thinking to pending:<id>; the open turn before it must stay running.
  const queued = [
    userRow('turn:1', 1),
    toolRow('turn:1', 'tool1', [preOpen]),
    replyRow('turn:1', 'Working on a.', 4),
    gap('pending:s1', 'gap:s1'),
    steerRow('pending:s1', 's1', { pending: true, steer: 'pending' }),
    thinking('pending:s1'),
  ];
  const queuedIndex = turnIndexOf(queued);
  assert.equal(queuedIndex.get('turn:1').running, true, 'pre-steer turn stays running while steer is queued');
  assert.equal(queuedIndex.get('turn:1'), queuedIndex.get('pending:s1'), 'queued steer aliases onto the open turn');

  // Cancelling the steer returns Thinking to turn:1 without ever flipping turn:1 to idle.
  const cancelled = [
    userRow('turn:1', 1),
    toolRow('turn:1', 'tool1', [preOpen]),
    replyRow('turn:1', 'Working on a.', 4),
    thinking('turn:1'),
  ];
  assert.equal(turnIndexOf(cancelled).get('turn:1').running, true);

  // Settled mid-turn steer (`steered: true`) continues under turn:2 while still part of the same turn loop.
  const settledSteerRunning = [
    userRow('turn:1', 1),
    toolRow('turn:1', 'tool1', [preOpen]),
    replyRow('turn:1', 'Working on a.', 4),
    gap('turn:2', 'gap:2'),
    steerRow('turn:2', 'u2', { steered: true }),
    toolRow('turn:2', 'tool2', [postOpen]),
    thinking('turn:2'),
  ];
  const runningIndex = turnIndexOf(settledSteerRunning);
  assert.equal(runningIndex.get('turn:1').running, true, 'pre-steer segment stays running while steered segment runs');
  assert.equal(runningIndex.get('turn:1'), runningIndex.get('turn:2'));

  // At the true end, all tool rounds from before and after the steer attach once to the final row.
  const settledSteerDone = [
    userRow('turn:1', 1),
    toolRow('turn:1', 'tool1', [preOpen]),
    replyRow('turn:1', 'Working on a.', 4),
    gap('turn:2', 'gap:2'),
    steerRow('turn:2', 'u2', { steered: true }),
    toolRow('turn:2', 'tool2', [postOpen]),
    {
      ...replyRow('turn:2', 'Done with a and b.', 10, changes1),
      completion: { kind: 'turndone', id: 'd1', status: 'done' },
    },
  ];
  const doneIndex = turnIndexOf(settledSteerDone);
  const merged = doneIndex.get('turn:1');
  assert.equal(merged, doneIndex.get('turn:2'));
  assert.equal(merged.running, false);
  assert.equal(merged.lastRow, settledSteerDone.length - 1, 'card attaches only to the final row after the steer');
  assert.deepEqual(merged.toolItems(), [preOpen, postOpen]);
  assert.deepEqual(merged.visualized(), ['site/a.html', 'site/b.html']);

  // Send-now (`steer: 'sending'`) after an ALREADY CLOSED turn starts a distinct TurnRows.
  const sendNowAfterClosed = [
    userRow('turn:1', 1),
    {
      ...replyRow('turn:1', 'Stopped.', 4, changes1),
      completion: { kind: 'turndone', id: 'd1', status: 'cancelled' },
    },
    gap('pending:s2', 'gap:s2'),
    steerRow('pending:s2', 's2', { pending: true, steer: 'sending' }),
    thinking('pending:s2'),
  ];
  const afterClosed = turnIndexOf(sendNowAfterClosed);
  assert.notEqual(afterClosed.get('turn:1'), afterClosed.get('pending:s2'));
  assert.equal(afterClosed.get('turn:1').running, false, 'already closed turn stays closed');
  assert.equal(afterClosed.get('pending:s2').running, true);
});

test('a completion wake closing the same checkpoint merges its tool rounds and visualize card onto the final row', () => {
  const { turnIndexOf } = createTurnIndexer(visualizedTargets);
  const firstOpen = open('o1', 'site/a.html', 'v1', 2);
  const wakeOpen = open('o2', 'site/b.html', 'v2', 12);
  const wakeChanges = { checkpointId: 'cp-wake', boundary: 'd2', trailing: true, reclosed: true };
  const rows = [
    {
      _tag: 'UserMessage',
      key: 'u1',
      turnKey: 'attempt:1',
      item: { kind: 'user', id: 'u1', checkpointId: 'cp-wake', text: 'build it', at: 1 },
    },
    toolRow('attempt:1', 'tool1', [firstOpen]),
    {
      ...replyRow('attempt:1', 'Worker started.', 5),
      completion: { kind: 'turndone', id: 'd1', status: 'done', checkpointId: 'cp-wake' },
    },
    toolRow('attempt:2', 'tool2', [wakeOpen]),
    {
      ...replyRow('attempt:2', 'All done.', 15, wakeChanges),
      completion: { kind: 'turndone', id: 'd2', status: 'done', checkpointId: 'cp-wake' },
    },
  ];
  const index = turnIndexOf(rows);
  const turn = index.get('attempt:1');
  assert.equal(turn, index.get('attempt:2'), 'wake shares the initial turn loop entry');
  assert.equal(turn.lastRow, rows.length - 1, 'visualize cards attach only to the final wake row');
  assert.equal(turn.changes, wakeChanges);
  assert.deepEqual(turn.toolItems(), [firstOpen, wakeOpen]);
  assert.deepEqual(turn.visualized(), ['site/a.html', 'site/b.html']);
  assert.deepEqual(turn.surfacedBefore, [], 'initial turn opens are not duplicated as surfacedBefore');
});

test('incremental indexing of a completion wake whose tool row arrives before its completion row matches cold indexing', () => {
  const firstOpen = open('o1', 'site/a.html', 'v1', 2);
  const wakeOpen = open('o2', 'site/b.html', 'v2', 12);
  const wakeChanges = { checkpointId: 'cp-wake', boundary: 'd2', trailing: true, reclosed: true };
  const initialRows = [
    {
      _tag: 'UserMessage',
      key: 'u1',
      turnKey: 'attempt:1',
      item: { kind: 'user', id: 'u1', checkpointId: 'cp-wake', text: 'build it', at: 1 },
    },
    toolRow('attempt:1', 'tool1', [firstOpen]),
    {
      ...replyRow('attempt:1', 'Worker started.', 5),
      completion: { kind: 'turndone', id: 'd1', status: 'done', checkpointId: 'cp-wake' },
    },
  ];
  const wakeToolRow = toolRow('attempt:2', 'tool2', [wakeOpen]);
  const liveWakeRows = [...initialRows, wakeToolRow, { _tag: 'Thinking', key: 'thinking', turnKey: 'attempt:2' }];
  noteCarried(liveWakeRows, initialRows, initialRows.length);

  const finalRows = [
    ...initialRows,
    wakeToolRow,
    {
      ...replyRow('attempt:2', 'All done.', 15, wakeChanges),
      completion: { kind: 'turndone', id: 'd2', status: 'done', checkpointId: 'cp-wake' },
    },
  ];
  noteCarried(finalRows, liveWakeRows, initialRows.length + 1);

  const incremental = createTurnIndexer(visualizedTargets);
  incremental.turnIndexOf(initialRows);
  const midIndex = incremental.turnIndexOf(liveWakeRows);
  assert.notEqual(
    midIndex.get('attempt:1'),
    midIndex.get('attempt:2'),
    'before completion row arrives, wake is separate'
  );

  const liveFinal = incremental.turnIndexOf(finalRows);
  const coldFinal = createTurnIndexer(visualizedTargets).turnIndexOf(finalRows);

  assert.deepEqual([...liveFinal.keys()], [...coldFinal.keys()]);
  assert.equal(liveFinal.get('attempt:1'), liveFinal.get('attempt:2'), 'wake merges into checkpoint turn');
  for (const key of ['attempt:1', 'attempt:2']) {
    const incTurn = liveFinal.get(key);
    const coldTurn = coldFinal.get(key);
    assert.equal(incTurn.lastRow, coldTurn.lastRow, `${key} lastRow`);
    assert.equal(incTurn.replyText, coldTurn.replyText, `${key} replyText`);
    assert.equal(incTurn.endedAt, coldTurn.endedAt, `${key} endedAt`);
    assert.equal(incTurn.changes, coldTurn.changes, `${key} changes`);
    assert.equal(incTurn.running, coldTurn.running, `${key} running`);
    assert.deepEqual(incTurn.liveRows, coldTurn.liveRows, `${key} liveRows`);
    assert.deepEqual(incTurn.replyRows, coldTurn.replyRows, `${key} replyRows`);
    assert.deepEqual(incTurn.surfacedBefore, coldTurn.surfacedBefore, `${key} surfacedBefore`);
    assert.deepEqual(incTurn.toolItems(), coldTurn.toolItems(), `${key} toolItems`);
    assert.deepEqual(incTurn.visualized(), coldTurn.visualized(), `${key} visualized`);
  }

  const nextRows = [...finalRows, userRow('attempt:3', 20)];
  noteCarried(nextRows, finalRows, finalRows.length);
  const liveNext = incremental.turnIndexOf(nextRows);
  const coldNext = createTurnIndexer(visualizedTargets).turnIndexOf(nextRows);
  assert.deepEqual(liveNext.get('attempt:3').surfacedBefore, coldNext.get('attempt:3').surfacedBefore);
});
