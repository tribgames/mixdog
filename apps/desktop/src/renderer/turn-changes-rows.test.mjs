import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { createSettledProjector, projectSettledTranscriptRows } from './transcript-rows.ts';
import { transcriptRowNode } from './conversation-support.tsx';
// The changes card under a turn's row, listing none of its preview card's files.
import { PreviewedTurnChangesCard as TurnChangesCard } from './transcript-visualize-card.tsx';

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
    // It stood on the earlier end: the wake's end does not hide it.
    reclosed: true,
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
  const card = children.find((child) => child?.type === TurnChangesCard);
  assert.equal(card.props.turnChanges, row.turnChanges);
  const plain = rows.find((candidate) => candidate._tag === 'UserMessage');
  assert.equal(plain.turnChanges, undefined);
});

/** The row node's children for `row`, with the turn's visualize cards seated. */
function seatedChildren(row, turnCards) {
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
    turnCards,
  });
  return node.props.children;
}

test('coding order: reply, then the visualize cards, then the changes card', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'done' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
  ]);
  const row = rows.find((candidate) => candidate.turnChanges);
  const seat = { cards: 'VISUALIZE', placed: false };
  const children = seatedChildren(row, seat);
  const changesAt = children.findIndex((child) => child?.type === TurnChangesCard);
  assert.deepEqual(children.slice(0, changesAt), ['assistant', 'VISUALIZE']);
  assert.equal(seat.placed, true);
});

test('the changes card is handed the files the turn visualized, on reply and error rows alike', () => {
  const visualized = ['design/mockups/app-skins/index.html'];
  const reply = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'done' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
  ]).find((row) => row.turnChanges);
  const card = seatedChildren(reply, { cards: 'VISUALIZE', placed: false, visualized }).find(
    (child) => child?.type === TurnChangesCard
  );
  assert.equal(card.props.visualized, visualized);
  const failed = project(
    [
      { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
      { kind: 'error', id: 'e1', text: 'boom' },
      { kind: 'turndone', id: 'd1', status: 'failed' },
    ],
    ['turn:u1']
  ).find((row) => row._tag === 'Error' && row.turnChanges);
  const errorCard = seatedChildren(failed, { cards: 'VISUALIZE', placed: false, visualized }).find(
    (child) => child?.type === TurnChangesCard
  );
  assert.equal(errorCard.props.visualized, visualized);
});

test('a sign-in-expired failure offers Sign in again and a retry for after signing in', () => {
  const items = [
    { kind: 'user', id: 'u1', text: 'one' },
    { kind: 'turndone', id: 'd1', status: 'failed', message: 'Sign-in expired.', errorKind: 'reauth' },
  ];
  const row = project(items, ['turn:u1']).find((candidate) => candidate._tag === 'Error');
  const retried = [];
  const node = transcriptRowNode(row, {
    disclosureScope: 's',
    optimisticActivityStartedAt: 0,
    readOnly: false,
    renderAssistantRow: () => 'assistant',
    retryDisabled: false,
    settledItems: items,
    settledTurnKeys: items.map(() => 'turn:u1'),
    snapshot: { sessionId: 's' },
    onRetryTurn(key) {
      retried.push(key);
    },
    onOpenSettings() {},
  });
  const notice = row.turnChanges ? node.props.children[0] : node;
  assert.ok(notice.props.action, 'Sign in again stays');
  assert.equal(typeof notice.props.onRetry, 'function');
  notice.props.onRetry();
  assert.deepEqual(retried, ['turn:u1']);
});

test("Sign in again opens Providers, for an agent route's card as for a provider's", () => {
  const opened = [];
  const press = (provider) => {
    const items = [
      { kind: 'user', id: 'u1', text: 'one' },
      {
        kind: 'turndone',
        id: 'd1',
        status: 'failed',
        message: 'Sign-in expired.',
        errorKind: { kind: 'auth', code: '', status: 0, retryAfterMs: null, resetAt: null },
        provider,
      },
    ];
    const row = project(items, ['turn:u1']).find((candidate) => candidate._tag === 'Error');
    const node = transcriptRowNode(row, {
      disclosureScope: 's',
      optimisticActivityStartedAt: 0,
      readOnly: false,
      renderAssistantRow: () => 'assistant',
      retryDisabled: false,
      settledItems: items,
      settledTurnKeys: items.map(() => 'turn:u1'),
      snapshot: { sessionId: 's' },
      onRetryTurn() {},
      onOpenSettings: (section) => opened.push(section),
    });
    (row.turnChanges ? node.props.children[0] : node).props.action.props.onClick();
  };
  const previous = globalThis.window;
  globalThis.window = { Event, dispatchEvent() {} };
  try {
    press('anthropic-oauth');
    assert.deepEqual(opened, ['providers']);
    press('acp-antigravity');
    assert.deepEqual(opened, ['providers', 'providers']);
  } finally {
    globalThis.window = previous;
  }
});

test('coding order on an error row: notice, then the visualize cards, then the changes card', () => {
  const rows = project(
    [
      { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
      { kind: 'tool', id: 't1', name: 'apply_patch', args: {}, result: 'ok' },
      { kind: 'error', id: 'e1', text: 'boom' },
      { kind: 'turndone', id: 'd1', status: 'failed' },
    ],
    ['turn:u1']
  );
  const row = rows.find((candidate) => candidate._tag === 'Error' && candidate.turnChanges);
  assert.ok(row, 'the error row holds the changes card');
  const seat = { cards: 'VISUALIZE', placed: false };
  const children = seatedChildren(row, seat);
  const changesAt = children.findIndex((child) => child?.type === TurnChangesCard);
  assert.equal(changesAt, children.length - 1);
  assert.equal(children[changesAt - 1], 'VISUALIZE');
  assert.equal(seat.placed, true);
});

test('a tool round names its recorded turn and the files that turn’s card leaves out', async () => {
  const { ToolTurnProvider } = await import('./TurnChangesCard.tsx');
  const items = [
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'tool', id: 't1', name: 'apply_patch', args: {}, result: 'ok' },
    { kind: 'assistant', id: 'a1', text: 'done' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
  ];
  const row = project(items).find((candidate) => candidate._tag === 'ToolActivity');
  const visualized = ['C:/repo/docs/chart.html'];
  const node = transcriptRowNode(row, {
    disclosureScope: 's',
    optimisticActivityStartedAt: 0,
    readOnly: false,
    renderAssistantRow: () => 'assistant',
    retryDisabled: false,
    settledItems: items,
    settledTurnKeys: items.map(() => 'turn:u1'),
    snapshot: { sessionId: 's' },
    onRetryTurn() {},
    onOpenSettings() {},
    turnCards: { cards: null, placed: false, visualized },
  });
  assert.equal(node.type, ToolTurnProvider);
  assert.equal(node.props.checkpointId, 'cp-1');
  assert.equal(node.props.boundary, 'd1', 'the end its card stands on');
  assert.equal(node.props.visualized, visualized);
});

test('a turn ending on a tool round after an assistant preamble places its changes card after the tools, not on the preamble', () => {
  const rows = project([
    { kind: 'user', id: 'u1', text: 'one', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'checking now' },
    { kind: 'tool', id: 't1', name: 'edit', args: {}, result: 'ok' },
    { kind: 'turndone', id: 'd1', status: 'complete' },
  ]);
  assert.deepEqual(
    rows.map((row) => row._tag),
    ['UserMessage', 'AssistantPart', 'ToolActivity', 'AssistantPart']
  );
  assert.deepEqual(cards(rows), [
    { tag: 'AssistantPart', key: 's:d1', checkpointId: 'cp-1', boundary: 'd1', trailing: true },
  ]);
});

test('a new prompt after multiple completions in one attempt keeps earlier completions folded when the final completion follows a tool', () => {
  const beforeNextPrompt = [
    { kind: 'user', id: 'u1', text: 'one', attemptId: 'att-1', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'step 1', attemptId: 'att-1' },
    { kind: 'turndone', id: 'd1', status: 'complete', attemptId: 'att-1' },
    { kind: 'assistant', id: 'a2', text: 'step 2', attemptId: 'att-1' },
    { kind: 'turndone', id: 'd2', status: 'complete', attemptId: 'att-1' },
    { kind: 'tool', id: 't1', name: 'edit', args: {}, result: 'ok', attemptId: 'att-1' },
    { kind: 'turndone', id: 'd3', status: 'complete', attemptId: 'att-1' },
  ];
  const afterNextPrompt = [...beforeNextPrompt, { kind: 'user', id: 'u2', text: 'two', attemptId: 'att-2' }];
  const projector = createSettledProjector();
  const projectWithAttemptKeys = (items) =>
    projector.project({
      sessionKey: 's',
      items,
      turnKeys: transcriptTurnKeys(items),
      failedTurns: new Set(),
    });

  const before = projectWithAttemptKeys(beforeNextPrompt);
  assert.equal(before.endsWithCompletion, true);
  assert.deepEqual(
    before.rows.map((row) => [row._tag, row.key]),
    [
      ['UserMessage', 's:u1'],
      ['AssistantPart', 's:a1'],
      ['AssistantPart', 's:a2'],
      ['ToolActivity', 's:t1:tool-activity'],
      ['AssistantPart', 's:d3'],
    ]
  );

  const after = projectWithAttemptKeys(afterNextPrompt);
  assert.equal(after.endsWithCompletion, false);
  assert.deepEqual(
    after.rows.map((row) => [row._tag, row.key]),
    [
      ['UserMessage', 's:u1'],
      ['AssistantPart', 's:a1'],
      ['AssistantPart', 's:a2'],
      ['ToolActivity', 's:t1:tool-activity'],
      ['AssistantPart', 's:d3'],
      ['TurnGap', 's:gap:u2'],
      ['UserMessage', 's:u2'],
    ]
  );
  assert.deepEqual(cards(after.rows), [
    { tag: 'AssistantPart', key: 's:d3', checkpointId: 'cp-1', boundary: 'd3', trailing: false },
  ]);
});

test('a cancelled attempt with an earlier successful end does not attach Completed to its reply after the next prompt', () => {
  const beforeNextPrompt = [
    { kind: 'user', id: 'u1', text: 'one', attemptId: 'att-1', checkpointId: 'cp-1' },
    { kind: 'assistant', id: 'a1', text: 'step 1', attemptId: 'att-1' },
    { kind: 'turndone', id: 'd1', status: 'complete', attemptId: 'att-1' },
    { kind: 'assistant', id: 'a2', text: 'step 2', attemptId: 'att-1' },
    { kind: 'turndone', id: 'd2', status: 'cancelled', attemptId: 'att-1' },
  ];
  const afterNextPrompt = [...beforeNextPrompt, { kind: 'user', id: 'u2', text: 'two', attemptId: 'att-2' }];
  const projector = createSettledProjector();
  const projectWithAttemptKeys = (items) =>
    projector.project({
      sessionKey: 's',
      items,
      turnKeys: transcriptTurnKeys(items),
      failedTurns: new Set(),
    });

  for (const [label, items, expectedTail] of [
    ['before next prompt', beforeNextPrompt, []],
    [
      'after next prompt',
      afterNextPrompt,
      [
        ['TurnGap', 's:gap:u2'],
        ['UserMessage', 's:u2'],
      ],
    ],
  ]) {
    const projected = projectWithAttemptKeys(items);
    assert.deepEqual(
      projected.rows.map((row) => [row._tag, row.key]),
      [
        ['UserMessage', 's:u1'],
        ['AssistantPart', 's:a1'],
        ['AssistantPart', 's:a2'],
        ['AssistantPart', 's:d2'],
        ...expectedTail,
      ],
      label
    );
    const a1Row = projected.rows.find((row) => row.key === 's:a1');
    const a2Row = projected.rows.find((row) => row.key === 's:a2');
    const d2Row = projected.rows.find((row) => row.key === 's:d2');
    assert.equal(a1Row?.completion, undefined, `${label}: a1 has no completion`);
    assert.equal(a2Row?.completion, undefined, `${label}: cancelled attempt does not attach earlier Completed to a2`);
    assert.equal(d2Row?.item?.status, 'cancelled', `${label}: cancelled end remains shown`);
    const trailing = label === 'before next prompt';
    assert.deepEqual(cards(projected.rows), [
      {
        tag: 'AssistantPart',
        key: 's:d2',
        checkpointId: 'cp-1',
        boundary: 'd2',
        trailing,
        ...(trailing ? { reclosed: true } : {}),
      },
    ]);
  }
});
