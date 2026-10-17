import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSettledTranscriptRows } from './transcript-rows.ts';
import { transcriptRowNode } from './conversation-support.tsx';
import { TurnChangesCard } from './TurnChangesCard.tsx';

/** Turn keys follow the prompt that opened each turn, like transcriptTurnKeys. */
function project(items, failed = []) {
  let turn = '';
  const turnKeys = items.map((item) => {
    if (item.kind === 'user') turn = `turn:${item.id}`;
    return turn;
  });
  return projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set(failed) }).rows;
}
const cards = (rows) =>
  rows.flatMap((row) => (row.turnChanges ? [{ tag: row._tag, key: row.key, ...row.turnChanges }] : []));

test('one card per checkpoint, on the row holding its last turndone', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'done' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
    { kind: 'user', id: 'u2', text: 'two' },
    { kind: 'assistant', id: 'a2', text: 'done' },
    { kind: 'turndone', id: 'd2', status: 'complete' },
  ]);
  assert.deepEqual(cards(rows), [
    { tag: 'AssistantPart', key: 's:a1', checkpointId: 'cp-1', boundary: 'd1', trailing: false },
    // Without a checkpointId the prompt's own id names the checkpoint.
    { tag: 'AssistantPart', key: 's:a2', checkpointId: 'u2', boundary: 'd2', trailing: true },
  ]);
});

test('a completion wake closing the same checkpoint moves the card to its later turndone', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'first' },
    { kind: 'turndone', id: 'd1', status: 'complete', checkpointId: 'cp-1' },
    { kind: 'user', id: 'wake', text: 'wake', internal: true },
    { kind: 'assistant', id: 'a2', text: 'after the wake' },
    { kind: 'turndone', id: 'd2', status: 'complete', checkpointId: 'cp-1' },
  ]);
  const placed = cards(rows);
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0], {
    tag: 'AssistantPart',
    key: 's:a2',
    checkpointId: 'cp-1',
    boundary: 'd2',
    trailing: true,
  });
});

test('a cancelled turn gets its card on the cancelled completion row', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'tool', id: 't1', name: 'apply_patch', args: {}, result: 'ok' },
    { kind: 'turndone', id: 'd1', status: 'cancelled' },
    { kind: 'user', id: 'u2', text: 'next' },
  ]);
  assert.deepEqual(cards(rows), [
    { tag: 'AssistantPart', key: 's:d1', checkpointId: 'cp-1', boundary: 'd1', trailing: false },
  ]);
});

test('a running turn (no turndone yet) has no card; a failed turn keeps its card on the error row', () => {
  assert.deepEqual(
    cards(
      project([
        { kind: 'user', id: 'u1', text: 'one' },
        { kind: 'assistant', id: 'a1', text: 'working' },
      ])
    ),
    []
  );
  const failed = project(
    [
      { kind: 'user', id: 'u1', text: 'one' },
      { kind: 'turndone', id: 'd1', status: 'failed' },
    ],
    ['turn:u1']
  );
  assert.deepEqual(cards(failed), [
    { tag: 'Error', key: 's:failed:turn:u1', checkpointId: 'u1', boundary: 'd1', trailing: true },
  ]);
});

test('hidden continuation failures keep one card per distinct checkpoint', () => {
  const rows = project(
    [
      { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
      { kind: 'turndone', id: 'd1', status: 'failed' },
      { kind: 'user', id: 'h2', text: 'continue', internal: true, checkpointId: 'cp-2' },
      { kind: 'turndone', id: 'd2', status: 'failed' },
    ],
    ['turn:u1', 'turn:h2']
  );
  assert.deepEqual(
    cards(rows).map(({ tag, checkpointId, boundary }) => ({ tag, checkpointId, boundary })),
    [
      { tag: 'Error', checkpointId: 'cp-1', boundary: 'd1' },
      { tag: 'Error', checkpointId: 'cp-2', boundary: 'd2' },
    ]
  );
});

test('hidden continuation failures on the same checkpoint still coalesce into one card', () => {
  const rows = project(
    [
      { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
      { kind: 'turndone', id: 'd1', status: 'failed' },
      { kind: 'user', id: 'h2', text: 'continue', internal: true },
      { kind: 'turndone', id: 'd2', status: 'failed', checkpointId: 'cp-1' },
    ],
    ['turn:u1', 'turn:h2']
  );
  const placed = cards(rows);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].checkpointId, 'cp-1');
  assert.equal(placed[0].boundary, 'd2');
});

test('the row node renders the card after its row', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'done' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
  ]);
  const row = rows.find((candidate) => candidate.turnChanges);
  const node = transcriptRowNode(row, {
    disclosureScope: 's',
    optimisticActivityStartedAt: 0,
    readOnly: false,
    renderAssistantRow: () => 'assistant',
    retryDisabled: false,
    settledItems: [],
    settledTurnKeys: [],
    snapshot: { sessionId: 's' },
    onRetryTurn() {},
    onOpenSettings() {},
  });
  const children = node.props.children;
  assert.equal(children[0], 'assistant');
  assert.equal(children[1].type, TurnChangesCard);
  assert.equal(children[1].props.turnChanges, row.turnChanges);
  const plain = rows.find((candidate) => candidate._tag === 'UserMessage');
  assert.equal(plain.turnChanges, undefined);
});
