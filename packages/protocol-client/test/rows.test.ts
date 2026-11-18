// Row parity with the Node product: rows-golden.json holds ThreadItems and the transcript rows Node's own projection
// (restore.mjs `restoreTranscriptItems`, agent-room.mjs `roomRowItem`) produced for the same conversation. `mergeToolRows(rowOf(item))`
// must equal them field for field, so the renderer, TUI and phone need no change.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { batchEntries, itemRows, mergeToolRows, rowOf, rowsOf } from '../src/rows.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';
// The installed Node history recordings of the phone's chat cases (apps/desktop), verified by their manifest elsewhere.
const historyDir = new URL('../../../apps/desktop/src/renderer/remote-protocol-chat-history.node/', import.meta.url);
const nodeRecording = (name: string): { history: { snapshot?: { items: Obj[] } }[] } => {
  for (const file of readdirSync(historyDir).filter((f) => /^\d+\.json$/.test(f))) {
    const recording = JSON.parse(readFileSync(new URL(file, historyDir), 'utf8'));
    if (recording.name === name) return recording;
  }
  throw new Error(`no Node history recording of ${name}`);
};

const golden = JSON.parse(readFileSync(new URL('rows-golden.json', import.meta.url), 'utf8')) as { cases: { name: string; items: Obj[]; rows: Obj[] }[] };
const project = (items: Obj[]): Obj[] => mergeToolRows(items.map(rowOf).filter((row): row is Obj => row !== null));

for (const c of golden.cases) {
  test(`rows equal the Node product's: ${c.name}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(project(c.items))), c.rows);
  });
}

test('a tool call still running is its own card, never part of an aggregate; reasoning has no row', () => {
  const call = (id: string, status: string, output?: string): Obj => ({ type: 'toolCall', id, name: 'read', input: { path: id }, ...(output === undefined ? {} : { output }), meta: { status, at: 1 } });
  const rows = project([
    call('a', 'completed', 'one'),
    call('b', 'completed', 'two'),
    call('c', 'inProgress'),
    { type: 'reasoning', id: 'r', summary: ['x'], content: [], meta: {} },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.name]), [['a', '__aggregate__'], ['c', 'read']]);
  assert.equal(rows[1]?.completedCount, 0);
  assert.equal('result' in (rows[1] ?? {}), false);
});

test('a live card completes at its result\'s time (aggregate-result.mjs completedAt: Date.now()); a restored one reads its message time', () => {
  const call = (run: Obj): Obj => ({ type: 'toolCall', id: 'a', name: 'read', input: { path: 'a' }, output: 'one', run, meta: { status: 'completed', at: 1000 } });
  const live = rowOf(call({ live: true, completedAt: 1015 }));
  assert.deepEqual([live?.startedAt, live?.completedAt], [1000, 1015]);
  const restored = rowOf(call({ completedAt: 1015 }));
  assert.deepEqual([restored?.startedAt, restored?.completedAt], [1000, 1000]);
});

test('a live card the Stop ended is Node\'s recorded card, whole (aggregate-result.mjs:80-91); one that finished is not cancelled', () => {
  // Node's card of the call the Stop ended (the last state of `running-approval-pending` in the installed Node history recordings),
  // against the row of the item the core holds for it, exactly.
  const states = nodeRecording('running-approval-pending').history.filter((h) => h.snapshot);
  const node = states.at(-1)!.snapshot!.items.find((row) => row.kind === 'tool')!;
  const member = (node.toolMembers as Obj[])[0]!;
  const call = (status: string): Obj => ({
    type: 'toolCall',
    id: node.id!,
    name: member.name!,
    input: member.args!,
    output: member.rawResult!,
    run: { live: true, callId: member.id, isError: true, completedAt: member.completedAt },
    meta: { status, at: member.startedAt },
  });
  const [stopped] = project([call('interrupted')]);
  assert.deepEqual(JSON.parse(JSON.stringify(stopped)), node);
  const [failed] = project([call('failed')]);
  assert.deepEqual([failed?.result, failed?.text, failed?.isError], ['1 Failed', '1 Failed', true]);
});

test('a turn end is the turndone row, with the live end\'s counters from ext and the typed message id on prompt, reply and end', () => {
  const rows = project([
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'go' }], meta: { at: 1, messageId: 'msg_u' } },
    { type: 'agentMessage', id: 'a', text: 'done', meta: { at: 2, messageId: 'msg_a', model: 'M', modelId: 'm', provider: 'p', agent: 'Default' } },
    {
      type: 'turnEnd',
      id: 'e',
      status: 'done',
      elapsedMs: 40,
      verb: 'Mapped',
      checkpointId: 'u',
      finalAssistantId: 'a',
      meta: { at: 3, model: 'M', modelId: 'm', provider: 'p', agent: 'Default', ext: { outputTokens: 48, thinkingElapsedMs: 0, toolCount: 1, attemptId: 't1', completionVerb: 'Mapped' } },
    },
  ]);
  assert.deepEqual(rows, [
    { kind: 'user', id: 'u', text: 'go', messageId: 'msg_u', at: 1 },
    { kind: 'assistant', id: 'a', text: 'done', messageId: 'msg_a', at: 2, modelId: 'm', model: 'M', provider: 'p', agent: 'Default' },
    {
      kind: 'turndone',
      id: 'e',
      checkpointId: 'u',
      elapsedMs: 40,
      status: 'done',
      finalAssistantId: 'a',
      verb: 'Mapped',
      at: 3,
      modelId: 'm',
      model: 'M',
      provider: 'p',
      agent: 'Default',
      outputTokens: 48,
      thinkingElapsedMs: 0,
      toolCount: 1,
      attemptId: 't1',
      completionVerb: 'Mapped',
    },
  ]);
});

test('a user row carries the stored original of each image line the core states, so the transcript chip can draw the picture', () => {
  const ref = 'e'.repeat(64);
  const line = '[Image: source: image.png, 893x258, displayed at 893x258]';
  const [row] = project([
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: `look\n${line}` }], details: { imageRefs: [{ line, ref }] }, meta: { at: 1 } },
  ]);
  assert.deepEqual(row?.imageRefs, [{ line, ref }]);
  const [plain] = project([{ type: 'userMessage', id: 'p', content: [{ type: 'text', text: 'hi' }], meta: {} }]);
  assert.equal('imageRefs' in (plain ?? {}), false);
});

test('a user row carries the stored attachments the core states, which its pasted-text and file chips read from the store', () => {
  const paste = { id: 'a'.repeat(64), attachmentRef: 'a'.repeat(64), kind: 'text', name: 'Pasted text #1', mimeType: 'text/plain', size: 40 };
  const file = { id: 'b'.repeat(64), attachmentRef: 'b'.repeat(64), kind: 'file', name: 'notes.pdf', mimeType: 'application/pdf', size: 9 };
  const [row] = project([
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'see [Pasted text #1 +3 lines]' }], details: { attachments: [paste, file] }, meta: { at: 1 } },
  ]);
  assert.deepEqual(row?.attachments, [paste, file]);
});

test('rows carry the product row model only: no protocol member names, compaction keeps status and label', () => {
  const rows = project([
    { type: 'toolCall', id: 'x', name: 'shell', input: { command: 'ls' }, output: '[exit code: 0]\nfile', meta: { status: 'completed' } },
    { type: 'contextCompaction', id: 'k', summary: 'long text', meta: { status: 'completed', at: 9 } },
    { type: 'agentMessage', id: 'm', text: 'hi', meta: { status: 'completed' } },
  ]);
  for (const row of rows) for (const leaked of ['type', 'meta', 'exitCode', 'durationMs', 'output', 'summary']) assert.equal(leaked in row, false, `${leaked} on ${row.id}`);
  assert.deepEqual(rows[1], { kind: 'statusdone', id: 'k', status: 'compacted', label: 'Conversation compacted', at: 9 });
  assert.equal('status' in (rows[2] ?? {}), false);
});


test('a history page row shows the compaction dividers the core says follow it, and never as an attribute of its own', async () => {
  const { rowsOf } = await import('../src/rows.ts');
  const divider: Obj = { type: 'contextCompaction', id: 'divider:k1', meta: { at: 5 } };
  const item: Obj = { type: 'agentMessage', id: 'a1', text: 'done', meta: { at: 4, ext: { archived: true, dividersAfter: [divider] } } };
  const rows = JSON.parse(JSON.stringify(rowsOf(item)));
  assert.deepEqual(rows, [
    { kind: 'assistant', id: 'a1', text: 'done', at: 4, archived: true },
    { kind: 'statusdone', id: 'divider:k1', status: 'compacted', label: 'Conversation compacted', at: 5 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rowOf(item))), rows[0], 'the row alone carries no divider list');
  assert.deepEqual(rowsOf({ type: 'agentMessage', id: 'a2', text: 'x', meta: {} }).length, 1);
});

const envelope = (id: string, status: string, summary: string, result = ''): string =>
  ['<task-notification>', `<task-id>${id}</task-id>`, `<status>${status}</status>`, `<summary>${summary}</summary>`, ...(result ? ['<result>', result, '</result>'] : []), '</task-notification>'].join('\n');

// Three mixed completions; the first one's result quotes the envelopes of the others and of itself (a result is not escaped).
const quoted = envelope('t-bad', 'failed', 'Agent "fix" failed: boom');
const okEnvelope = envelope('t-ok', 'completed', 'Agent "rev" completed', `see 한글 😀\n${quoted}\n${envelope('t-sh', 'completed', 'Shell task completed (exit 0): npm test')}`);
const badEnvelope = quoted;
const shellEnvelope = envelope('t-sh', 'completed', 'Shell task completed (exit 0): npm test');
const texts = [okEnvelope, badEnvelope, shellEnvelope];
const joined = texts.join('\n');
const located = (() => {
  let at = 0;
  return texts.map((t, k) => {
    const start = at;
    at += t.length + 1; // UTF-16 units, as JavaScript counts them
    return { executionId: ['t-ok', 't-bad', 't-sh'][k], surface: ['agent', 'agent', 'shell'][k], status: ['completed', 'failed', 'completed'][k], start, end: start + t.length };
  });
})();
const batchItem = (details: Obj, text = joined): Obj => ({
  type: 'userMessage',
  id: 'u1',
  content: [{ type: 'text', text }],
  details: { source: 'task-notification', ...details },
  meta: { at: 5, ext: { execution: { id: 't-ok', surface: 'agent', status: 'completed' } } },
});
const shown = (rows: Obj[]) => rows.map((r) => [r.id, r.kind, r.name, (r.args as Obj).task_id, (r.args as Obj).status, r.isError, r.count, String(r.result).length]);
const wantCards = [
  ['u1', 'tool', 'agent', 't-ok', 'completed', false, 1, okEnvelope.length],
  ['u1:1', 'tool', 'agent', 't-bad', 'failed', true, 1, badEnvelope.length],
  ['u1:2', 'tool', 'shell', 't-sh', 'completed', false, 1, shellEnvelope.length],
];

test('a batch of three completions the core wrote with its entries shows three cards, cut by the entries and not by the text', () => {
  const rows = rowsOf(batchItem({ consumedExecutionIds: ['t-ok', 't-bad', 't-sh'], completions: located }));
  assert.deepEqual(shown(rows), wantCards);
  assert.equal(mergeToolRows(rows).flatMap((card) => (Array.isArray(card.toolMembers) ? (card.toolMembers as Obj[]) : [card])).length, 3);
});

test('a batch stored before the entries existed is located by its execution ids; a result quoting other envelopes is not cut', () => {
  const other = envelope('t-other', 'completed', 'Agent "o" completed', 'quoted');
  const quoting = envelope('t-ok', 'completed', 'Agent "rev" completed', `${other}\n${other}`);
  const rows = rowsOf(batchItem({ consumedExecutionIds: ['t-ok', 't-bad', 't-sh'] }, [quoting, badEnvelope, shellEnvelope].join('\n')));
  assert.deepEqual(shown(rows), [
    ['u1', 'tool', 'agent', 't-ok', 'completed', false, 1, quoting.length],
    ['u1:1', 'tool', 'agent', 't-bad', 'failed', true, 1, badEnvelope.length],
    ['u1:2', 'tool', 'shell', 't-sh', 'completed', false, 1, shellEnvelope.length],
  ]);
});

test('a batch row whose entries cannot all be located stays one card; a single completion is never split', () => {
  assert.equal(rowsOf(batchItem({ consumedExecutionIds: ['t-ok', null, 't-sh'] })).length, 1);
  assert.equal(rowsOf(batchItem({ consumedExecutionIds: ['t-ok', 'restart:t-bad', 't-sh'] })).length, 1);
  const lone = batchItem({ consumedExecutionIds: ['t-ok'] }, okEnvelope);
  assert.deepEqual(itemRows(lone).map((r) => r.id), ['u1']);
  assert.deepEqual(batchEntries(okEnvelope, { consumedExecutionIds: ['t-ok'] }), []);
});

test('imported prose and counted tools interleave without replacing edited markers or duplicating rows on replay', () => {
  const prefix = '😀 First.\n\n';
  const marker = '[ran tools: read ×2, grep ×1]';
  const between = '\n\n[ran tools: shell ×99]\n\n';
  const lastMarker = '[ran tools: shell ×1]';
  const lastStart = prefix.length + marker.length + between.length;
  const item = {
    type: 'agentMessage', id: 'imported', text: `${prefix}${marker}${between}${lastMarker}\n\nDone.`,
    importedToolRuns: [
      { start: prefix.length, end: prefix.length + marker.length, tools: [{ name: 'read', count: 2 }, { name: 'grep', count: 1 }] },
      { start: prefix.length + marker.length + 2, end: lastStart - 2, tools: [{ name: 'shell', count: 1 }] },
      { start: lastStart, end: lastStart + lastMarker.length, tools: [{ name: 'shell', count: 1 }] },
    ],
    meta: { at: 42, messageId: 'msg_imported', provider: 'p' },
  };
  const prose = (id: string, text: string) => ({ kind: 'assistant', id, text, at: 42, messageId: 'msg_imported', provider: 'p' });
  const tool = (id: string, name: string, count: number) => ({ kind: 'tool', id, name, count, completedCount: count, imported: true, expanded: false, at: 42, startedAt: 42, completedAt: 42 });
  const expected = [
    prose('imported', '😀 First.'),
    tool('imported:import:1', 'read', 2),
    tool('imported:import:2', 'grep', 1),
    prose('imported:import:3', '[ran tools: shell ×99]'),
    tool('imported:import:4', 'shell', 1),
    prose('imported:import:5', 'Done.'),
  ];
  assert.deepEqual(rowsOf(item), expected, 'history page');
  const tail = { type: 'agentMessage', id: 'imported:1', text: 'Later.' };
  const fold = sessionReducer.initial({ thread: { id: 't' }, items: [item, tail], state: {} });
  const replayed = sessionReducer.apply(fold, { method: 'item/completed', params: { item } } as never);
  assert.deepEqual(desktopSessionState(replayed, []).items, [...expected, { kind: 'assistant', id: tail.id, text: tail.text }]);
});

test('completed tools preserve only validated metadata, including ownership on each grouped preview', () => {
  const call = (id: string, toolMeta: Obj): Obj => ({ type: 'toolCall', id, name: 'visualize', input: {}, meta: { status: 'completed' }, run: { result: 'opened', toolMeta } });
  const valid = call('one', { code: 'visualize_owner', missing: ['display', '', 5], ownerSessionId: 'room:owner-1', extra: 'ignored' });
  const invalid = call('two', { code: 'visualize_owner', ownerSessionId: '../other/session' });
  const expected = { code: 'visualize_owner', missing: ['display'], ownerSessionId: 'room:owner-1' };
  assert.deepEqual(rowOf(valid)?.toolMeta, expected);
  const [group] = project([valid, invalid]);
  assert.deepEqual((group?.toolMembers as Obj[] | undefined)?.map((row) => row.toolMeta), [
    expected, { code: 'visualize_owner', missing: [] },
  ]);
  assert.equal(rowOf(call('three', { ownerSessionId: 'valid-shape' }))?.toolMeta, undefined);
});

test('a routine prompt restores the trigger and one reaction per bot', () => {
  const row = rowOf({
    type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'check' }],
    details: {
      source: 'routine-trigger', routineTrigger: { kind: 'webhook', name: ' Checks ', event: ' opened ' },
      reactions: [{ agentId: 'bot', emoji: '👍', at: 4 }, { agentId: 'bot', emoji: '👋' }, { agentId: 'bad/bot', emoji: '👍' }],
    },
  });
  assert.deepEqual(row?.routineTrigger, { kind: 'webhook', name: 'Checks', event: 'opened' });
  assert.deepEqual(row?.reactions, [{ agentId: 'bot', emoji: '👍', at: 4 }]);
});

test('a posted task report restores its typed stamp and downloadable artifact', () => {
  const id = 'a'.repeat(64);
  const attachment = { id, name: 'report.txt', kind: 'file', mimeType: 'text/plain', size: 5 };
  const files = [{ ...attachment, path: '/report.txt' }];
  const routine = { kind: 'task', name: 'Build', status: 'completed', files };
  const row = rowOf({
    type: 'userMessage', id: 'notice', content: [],
    details: { source: 'schedule-result', attachments: [attachment, attachment] },
    meta: { messageId: 'msg_notice', posted: true, at: 7, ext: { routine, messageId: 'old', posted: false } },
  });
  assert.deepEqual(row, {
    kind: 'notice', id: 'notice', text: '🛠 Agent task completed · Build', tone: 'info',
    messageId: 'msg_notice', posted: true, at: 7, routine, attachments: [{ ...attachment, attachmentRef: id }],
  });
});