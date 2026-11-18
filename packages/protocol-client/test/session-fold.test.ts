// The fold's own behaviour through the thread feed: prompt history, a compaction's archived rows, and a snapshot followed by
// notifications over the mock transport reading as sessionStateOf. Inputs are inline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { sessionReducer, sessionStateOf } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

type O = Record<string, any>;
const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

test('prompt history and history reset fold from the core', () => {
  const snap = (state: unknown, hasOlder = true) => sessionReducer.initial({ thread: { id: 't' }, items: [], state, hasOlder } as unknown as Json);
  const at = (s: SessionFold, method: string, params: unknown) => sessionReducer.apply(s, { method, params } as never);
  let s = snap({ promptHistoryList: ['b  c', 'a'] });
  assert.deepEqual(s.fields.promptHistoryList, ['b  c', 'a']);
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'a' } });
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'b\n c' } });
  assert.deepEqual(s.fields.promptHistoryList, ['b\n c', 'a']);
  const full = Array.from({ length: 50 }, (_, i) => `p${i}`);
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'replaced', prompts: full } });
  s = at(s, 'thread/promptHistory/updated', { threadId: 't', value: { kind: 'added', prompt: 'new' } });
  assert.deepEqual(s.fields.promptHistoryList, ['new', ...full.slice(0, 49)]);
  assert.equal(s.fields.transcriptHasOlder, true);
  s = at(s, 'thread/historyReset', { threadId: 't', reason: 'clear', hasOlder: false });
  assert.equal('transcriptHasOlder' in s.fields, false);
  s = at(s, 'thread/historyReset', { threadId: 't', reason: 'rewind', fromItemId: 'gone', hasOlder: true });
  assert.equal(s.fields.transcriptHasOlder, true);
});

test('a compaction archives the rows the store holds in place and adds none of the older ones below the divider', () => {
  const at = (s: SessionFold, item: O) => sessionReducer.apply(s, { method: 'item/completed', params: { threadId: 't', turnId: '', item } } as never);
  const user = (id: string, text: string, ext: O = {}) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], meta: { ext } });
  const reply = (id: string, text: string, ext: O = {}) => ({ type: 'agentMessage', id, text, meta: { ext } });
  const call = (id: string, name: string, ext: O = {}) => ({ type: 'toolCall', id, name, input: { path: '.' }, run: { callId: id, result: 'ok' }, meta: { status: 'completed', ext } });
  const divider = { type: 'contextCompaction', id: 'divider:c1', meta: { label: 'Conversation compacted', detail: '520k→41k' } };
  // The store's tail: the last turn before the compaction, then the turn the compaction ran in.
  const held = [user('u1', 'look'), call('call:read-1', 'read'), call('call:grep-1', 'grep'), reply('a1', 'found it'), user('u2', 'go on')];
  let s = sessionReducer.initial({ thread: { id: 't' }, items: held, state: {}, hasOlder: true } as unknown as Json);
  s = at(s, divider);
  // The core then sends every row of its window again, archived: rows older than this tail first, then the held ones.
  const archived = { archived: true };
  for (const item of [
    user('u0', 'older prompt', archived),
    call('call:list-0', 'list', archived),
    call('call:explore-0', 'explore', archived),
    reply('a0', 'older reply', archived),
    ...held.slice(0, 4).map((item) => ({ ...item, meta: { ...item.meta, ext: { ...item.meta.ext, ...archived } } })),
  ]) {
    s = at(s, item);
  }
  assert.deepEqual(
    s.items.map((row) => [row.id, row.archived === true]),
    [['u1', true], ['call:read-1', true], ['call:grep-1', true], ['a1', true], ['u2', false], ['divider:c1', false]],
    'held rows dim where they are; none of the older ones lands after the divider'
  );
  // The current turn goes on below the divider as before.
  s = at(s, call('call:shell-2', 'shell'));
  assert.deepEqual(s.items.slice(-2).map((row) => row.id), ['divider:c1', 'call:shell-2']);
});

test('a snapshot and the notifications after it fold into the thread state a client reads', async () => {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent(); // initialized
  const client = await connecting;
  const answer = async (result: Json): Promise<void> => conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result });
  let seq = 0;
  const feed = (method: string, params: unknown) => conn.serverSend({ method, params, feed: { id: 'lead', epoch: 'e1', seq: seq++ } });
  const thread = { id: 'lead', preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null };
  const resumed = client.resumeThread('lead', { lastItems: 50 });
  await answer({ thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } } as unknown as Json);
  await resumed;

  feed('thread/snapshot', {
    thread: { id: 'lead' },
    state: { queued: [], runtime: { busy: false, thinking: false }, goal: { objective: 'ship' } },
    items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }], meta: { ext: {} } }],
    hasOlder: false,
  });
  feed('thread/runtime/updated', { threadId: 'lead', value: { busy: true, thinking: true } });
  feed('item/completed', { threadId: 'lead', turnId: 'turn', item: { type: 'agentMessage', id: 'a1', text: 'hello', meta: { ext: {} } } });
  feed('thread/goal/updated', { threadId: 'lead', value: null });
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

  const got = sessionStateOf(client, 'lead') as O;
  assert.equal(got.busy, true);
  assert.equal(got.thinking, true);
  assert.equal(got.goal, null);
  assert.deepEqual(got.items.map((row: O) => [row.id, row.kind, row.text]), [['u1', 'user', 'hi'], ['a1', 'assistant', 'hello']]);
  await client.close();
});
