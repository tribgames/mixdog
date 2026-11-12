// Row parity with the Node product: rows-golden.json holds ThreadItems and the transcript rows Node's own projection
// (restore.mjs `restoreTranscriptItems`, agent-room.mjs `roomRowItem`) produced for the same conversation. `mergeToolRows(rowOf(item))`
// must equal them field for field, so the renderer, TUI and phone need no change.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { mergeToolRows, rowOf } from '../src/rows.ts';
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
    id: node.id,
    name: member.name,
    input: member.args,
    output: member.rawResult,
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

