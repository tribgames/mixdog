// A compaction keeps the visible conversation: the rows it took out of the
// model context stay in view, archived, above the compaction divider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveItemsForCompaction, compactionArchivedRows } from './compaction-view.mjs';
import { createSessionApiA } from './session-api.mjs';
import { applyCompactEvent } from './turn.mjs';
import { stampMessageIds } from '../../runtime/agent/orchestrator/session/message-ids.mjs';
import { restoreTranscriptItems } from '../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';

const user = (id, text = `prompt ${id}`) => ({ kind: 'user', id, text });
const assistant = (id) => ({ kind: 'assistant', id, text: `reply ${id}` });

test('archiving marks the rows before the boundary and inserts the divider there', () => {
  const rows = [user('u1'), assistant('a1'), user('u2')];
  const { items, dividerIndex } = archiveItemsForCompaction(rows, { id: 'd', label: 'Compact complete' }, 2);
  assert.equal(dividerIndex, 2);
  assert.deepEqual(
    items.map((item) => [item.id, item.archived === true]),
    [
      ['u1', true],
      ['a1', true],
      ['d', false],
      ['u2', false],
    ]
  );
  assert.equal(items[2].status, 'compacted');
  assert.equal(items[3], rows[2]);
  // An earlier divider stays a divider, not an archived row.
  const again = archiveItemsForCompaction(items, { id: 'd2', label: 'Compact complete' }).items;
  assert.equal(again[2].archived, undefined);
});

test('manual compaction keeps the transcript, archived above the divider', async () => {
  let state = { busy: false, commandBusy: false, items: [user('u1'), assistant('a1')], stats: {} };
  const set = (patch) => {
    state = { ...state, ...patch };
  };
  let sequence = 0;
  const api = createSessionApiA({
    runtime: { compact: async () => ({ changed: true, beforeTokens: 1_000, afterTokens: 100 }) },
    nextId: () => `it_${++sequence}`,
    flags: {},
    pending: [],
    listeners: new Set(),
    getState: () => state,
    getPublishedState: () => state,
    set,
    flushEmitImmediate: () => {},
    pushItem: (item) => set({ items: [...state.items, item] }),
    replaceItems: (items) => items,
    routeState: () => ({}),
    syncContextStats: () => {},
  });
  await api.compact();
  assert.deepEqual(
    state.items.map((item) => [item.id, item.archived === true]),
    [
      ['u1', true],
      ['a1', true],
      ['it_1', false],
    ]
  );
  assert.equal(state.items[0].text, 'prompt u1');
  assert.equal(state.items.at(-1).label, 'Conversation compacted');
  assert.equal(state.items.at(-1).status, 'compacted');
});

test('a rewrite-only compaction keeps every row live and only marks the boundary', () => {
  const rows = [user('u1'), assistant('a1')];
  const { items } = archiveItemsForCompaction(rows, { id: 'd' }, null, {
    archived: compactionArchivedRows({ droppedMessages: 0, droppedIdentities: null }),
  });
  assert.equal(items[0], rows[0]);
  assert.equal(items[1], rows[1]);
  assert.equal(items[2].status, 'compacted');
  assert.equal(items[2].label, 'Conversation compacted');
});

test('a mixed compaction greys exactly the rows whose message or call ids left', () => {
  const rows = [
    { kind: 'user', id: 'u1', text: 'old', messageId: 'msg_old', at: 1 },
    { kind: 'tool', id: 't1', name: 'read', callId: 'c1' },
    { kind: 'assistant', id: 'a1', text: 'old reply', messageId: 'msg_old_reply', at: 2 },
    // A completion row has no message of its own: it follows its prompt.
    { kind: 'turndone', id: 'd1', status: 'done' },
    // [p, r] → [r]: the prompt left, its reply was kept.
    { kind: 'user', id: 'u2', text: 'p', messageId: 'msg_p', at: 3 },
    { kind: 'assistant', id: 'a2', text: 'r', messageId: 'msg_r', at: 3 },
    // Kept (its tool output was only rewritten).
    { kind: 'user', id: 'u3', text: 'recent', messageId: 'msg_recent', at: 5 },
    { kind: 'tool', id: 't3', name: 'read', callId: 'c3' },
    { kind: 'assistant', id: 'a3', text: 'recent reply', messageId: 'msg_recent_reply', at: 6 },
    { kind: 'turndone', id: 'd3', status: 'done' },
  ];
  const { items } = archiveItemsForCompaction(rows, { id: 'div' }, null, {
    archived: compactionArchivedRows({
      droppedMessages: 4,
      droppedIdentities: { messageIds: ['msg_old', 'msg_old_reply', 'msg_p'], callIds: ['c1'] },
    }),
  });
  assert.deepEqual(
    items.map((item) => [item.id, item.archived === true]),
    [
      ['u1', true],
      ['t1', true],
      ['a1', true],
      ['d1', true],
      ['u2', true],
      ['a2', false],
      ['u3', false],
      ['t3', false],
      ['a3', false],
      ['d3', false],
      ['div', false],
    ]
  );
  // Rows of kept messages keep their identity (no re-render, actions intact).
  assert.equal(items[5], rows[5]);
  assert.equal(items[6], rows[6]);
});

test('message-backed rows never inherit their turn; only auxiliary rows do', () => {
  const archived = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: ['msg_p'], callIds: [] },
  });
  const rows = [
    { kind: 'user', id: 'u', text: 'p', messageId: 'msg_p' },
    // No id: no display identity in the result, so it stays live.
    { kind: 'assistant', id: 'a', text: 'r' },
    { kind: 'tool', id: 't', name: 'read' },
    // No message of its own: follows the dropped prompt.
    { kind: 'turndone', id: 'd', status: 'done' },
  ];
  assert.deepEqual(
    rows.map((row) => archived(row)),
    [true, false, false, true]
  );
});

test('restored legacy rows without times or call ids carry stamped ids and are greyed live', () => {
  const sessionId = 'legacy-live';
  // A legacy transcript: no transcript metadata at all, including the
  // interrupted-turn marker that restores as a "Cancelled" row.
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: '[Request interrupted by process restart]' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' },
  ];
  // Resume stamps the transcript before its rows are restored.
  stampMessageIds(messages, { sessionId });
  const rows = restoreTranscriptItems(messages, { sessionId });
  assert.ok(rows.every((row) => typeof row.messageId === 'string' && row.messageId));
  const marker = rows.find((row) => row.kind === 'turndone' && row.status === 'cancelled');
  assert.ok(marker);
  const droppedIds = messages.slice(0, 3).map((message) => message.meta.transcript.messageId);
  const { items } = archiveItemsForCompaction(rows, { id: 'div' }, null, {
    archived: compactionArchivedRows({
      droppedMessages: 3,
      droppedIdentities: { messageIds: droppedIds, callIds: [] },
    }),
  });
  assert.deepEqual(
    items.map((item) => [item.text ?? item.status, item.archived === true]),
    [
      ['old question', true],
      ['old answer', true],
      ['cancelled', true],
      ['new question', false],
      ['new answer', false],
      ['compacted', false],
    ]
  );
});

test('a manual compaction that dropped some messages archives only their rows', async () => {
  let state = {
    busy: false,
    commandBusy: false,
    items: [
      { kind: 'user', id: 'u1', text: 'old', messageId: 'msg_old', at: 1 },
      { kind: 'user', id: 'u2', text: 'kept', messageId: 'msg_kept', at: 2 },
    ],
    stats: {},
  };
  const set = (patch) => {
    state = { ...state, ...patch };
  };
  const api = createSessionApiA({
    runtime: {
      compact: async () => ({
        changed: true,
        droppedMessages: 1,
        droppedIdentities: { messageIds: ['msg_old'], userAts: [1], assistantAts: [], callIds: [] },
      }),
    },
    nextId: () => 'div',
    flags: {},
    pending: [],
    listeners: new Set(),
    getState: () => state,
    getPublishedState: () => state,
    set,
    flushEmitImmediate: () => {},
    pushItem: (item) => set({ items: [...state.items, item] }),
    replaceItems: (items) => items,
    routeState: () => ({}),
    syncContextStats: () => {},
  });
  await api.compact();
  assert.deepEqual(
    state.items.map((item) => [item.id, item.archived === true]),
    [
      ['u1', true],
      ['u2', false],
      ['div', false],
    ]
  );
});

function compactCtx(items, submittedIds) {
  const box = { state: { items, stats: {} } };
  let sequence = 0;
  box.ctx = {
    turn: { submittedIds, currentItemsStart: 0, transcriptCompacted: false },
    stream: { batchTimer: null, isCurrentTurn: () => false },
    cards: { aggregates: { clearAggregateContinuation: () => {} } },
    getState: () => box.state,
    set: (patch) => {
      box.state = { ...box.state, ...patch };
    },
    replaceItems: (next) => next,
    pushItem: (item) => {
      box.state = { ...box.state, items: [...box.state.items, item] };
    },
    nextId: () => `it_${++sequence}`,
    syncContextStats: () => {},
    routeState: () => ({}),
  };
  return box;
}

test('current-turn tool calls the compaction dropped are archived live, as a restart restores them', () => {
  const rows = [
    { kind: 'user', id: 'u1', messageId: 'm1' },
    { kind: 'user', id: 'u2', messageId: 'm2' },
    { kind: 'tool', id: 't1', callId: 'c1', name: 'read' },
    { kind: 'tool', id: 't2', callId: 'c2', name: 'read' },
  ];
  const event = {
    status: 'compacted',
    droppedMessages: 2,
    droppedIdentities: { messageIds: ['m1'], callIds: ['c1'] },
  };
  const box = compactCtx(rows, ['u2']);
  applyCompactEvent(box.ctx, event);
  const live = box.state.items
    .filter((item) => item.status !== 'compacted')
    .map((item) => [item.id, item.archived === true]);
  const restart = archiveItemsForCompaction(rows, { id: 'd' }, null, { archived: compactionArchivedRows(event) })
    .items.filter((item) => item.status !== 'compacted')
    .map((item) => [item.id, item.archived === true]);
  assert.deepEqual(live, restart);
  assert.deepEqual(live, [
    ['u1', true],
    ['u2', false],
    ['t1', true],
    ['t2', false],
  ]);
});

test('an aggregate row with surviving calls marks only its dropped members archived', () => {
  const aggregate = {
    kind: 'tool',
    id: 'agg',
    aggregate: true,
    toolMembers: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
  };
  const archived = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [], callIds: ['c1', 'c3'] },
  });
  const { items } = archiveItemsForCompaction([aggregate], { id: 'd' }, null, { archived });
  assert.equal(items[0].archived, undefined);
  assert.deepEqual(
    items[0].toolMembers.map((member) => [member.id, member.archived === true]),
    [
      ['c1', true],
      ['c2', false],
      ['c3', true],
    ]
  );
  // Every call dropped: the whole row is archived.
  const all = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [], callIds: ['c1', 'c2', 'c3'] },
  });
  assert.equal(archiveItemsForCompaction([aggregate], { id: 'd' }, null, { archived: all }).items[0].archived, true);
});

test('a mid-turn compaction keeps earlier rows archived and the current turn live after the divider', () => {
  let state = {
    items: [user('u1'), assistant('a1'), user('u2'), { kind: 'tool', id: 't1', name: 'read' }],
    stats: {},
  };
  let sequence = 0;
  const ctx = {
    turn: { submittedIds: ['u2'], currentItemsStart: 0, transcriptCompacted: false },
    stream: { batchTimer: null, isCurrentTurn: () => false },
    cards: { aggregates: { clearAggregateContinuation: () => {} } },
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    replaceItems: (items) => items,
    pushItem: (item) => {
      state = { ...state, items: [...state.items, item] };
    },
    nextId: () => `it_${++sequence}`,
    syncContextStats: () => {},
    routeState: () => ({}),
  };
  applyCompactEvent(ctx, { status: 'compacted', stage: 'pre_send', trigger: 'auto' });
  assert.deepEqual(
    state.items.map((item) => [item.id, item.archived === true]),
    [
      ['u1', true],
      ['a1', true],
      ['it_1', false],
      ['u2', false],
      ['t1', false],
    ]
  );
  assert.equal(state.items[2].status, 'compacted');
  assert.equal(ctx.turn.currentItemsStart, 3);
  assert.equal(ctx.turn.transcriptCompacted, true);

  applyCompactEvent(ctx, { status: 'failed', stage: 'pre_send', trigger: 'auto', error: 'x' });
  assert.equal(state.items.at(-1).id, 'it_2');
  assert.equal(state.items.at(-1).status, undefined);
  assert.equal(state.items[3].archived, undefined);
});
