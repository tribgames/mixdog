// The host adapter's own calls over a scripted `mixdogd` (remote-chat-host.ts): the three start calls (a blank snapshot, no thread),
// the remote-session fields every snapshot carries, transcript paging, the stale-view refusal, and the refusal texts.
// Inputs and the scripted core replies are inline; each expectation follows the rule in remote-chat-host.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { scopeClient } from '../../../mobile/src/phone-send-scope.ts';
import { createChatApi, foldTranscript } from './remote-protocol-chat.ts';
import { createChatHostApi } from './remote-chat-host.ts';

const S = 'sess_a';
const ROOT = '/phone/root';
const at = (value) => (typeof value === 'string' ? value.replaceAll('<ROOT>', ROOT) : JSON.parse(JSON.stringify(value).replaceAll('<ROOT>', ROOT)));

const rpcError = (reason, extra = {}) =>
  Object.assign(new Error(reason), { detail: { kind: 'rpc', code: -32000, reason, message: reason, data: { reason, ...extra } } });
const domainError = (code, message) => rpcError('domainError', { ...(code ? { code } : {}), message });

/** A Node transcript row as the item mixdogd holds it (the inverse of `rowOf` for the plain rows of these recordings). */
const itemOf = (row) =>
  row.kind === 'user'
    ? { type: 'userMessage', id: row.id, content: [{ type: 'text', text: row.text }], ...(row.device ? { device: row.device } : {}), meta: {} }
    : { type: 'agentMessage', id: row.id, text: row.text, meta: {} };
const foldRows = (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean));

/** The host adapter over a scripted core: `replies` by protocol method (an Error is thrown), `state` the thread the phone holds. */
function adapter({ replies = {}, state, remoteSession, device = 'Pixel 9' }) {
  const sent = [];
  // PH-1: a call's transmission claim reaches the writer as the `sent` option of the client method (phone-send-scope.ts). The client the
  // adapter reaches is the call's scoped client; a request written without the claim is listed in `unclaimed`.
  const claim = () => {};
  const unclaimed = [];
  const raw = {
    call: async (method, params, options) => {
      sent.push({ method, params });
      if (options?.sent !== claim) unclaimed.push(method);
      if (!Object.hasOwn(replies, method)) throw new Error(`unscripted request ${method}`);
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(params) : reply;
    },
    resumeThread: async (threadId, window, options) => {
      sent.push({ resume: threadId, window });
      if (options?.sent !== claim) unclaimed.push(`resumeThread ${threadId}`);
      return {};
    },
    unsubscribeThread: async (threadId, options) => {
      if (options?.sent !== claim) unclaimed.push(`unsubscribeThread ${threadId}`);
    },
    server: { connection: { device } },
  };
  const client = scopeClient(raw, claim);
  const protocol = {
    call: (method, params) => client.call(method, params),
    snapshot: () => ({ entries: [] }),
    noteUserInput() {},
    respond() {},
    pendingServerRequests: () => [],
  };
  const shared = {
    routeService,
    lane: createCapabilityLane({ protocol }),
    coreErrorForWindow,
    normalizedProviderModels: (rows) => rows,
    sessionStateOf: () => state,
    whenFolded: (_threadId, resume) => resume().then(() => undefined),
    whenSettled: async () => undefined,
    approvalRequestId: (cardId) => cardId,
    transcript: foldTranscript(client),
    foldRows,
  };
  const api = createChatHostApi(client, shared, createChatApi(client, shared), { remoteSession: () => remoteSession });
  return { api, sent, unclaimed };
}

const failure = (error) => ({ message: error.message, ...(error.name === 'TypeError' || error.name === 'Error' ? { name: error.name } : {}), ...(error.code ? { code: error.code } : {}) });
const outcome = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
};


const rows = (...ids) => ids.map((id) => ({ id, kind: 'user', text: id }));

test('history keeps the original body and a digest cannot authorize replay of a stored row', async () => {
  const full = `${'original output\n'.repeat(2_000)}last line`;
  const row = {
    type: 'toolCall',
    id: 'tool-1',
    name: 'shell',
    input: {},
    meta: { status: 'completed', ext: { historyPosition: 'h1:0:record-1' } },
    run: { result: full, rawResult: full, count: 1 },
  };
  const { api, sent, unclaimed } = adapter({
    state: { items: [] },
    replies: { 'thread/items/list': { data: [row] } },
  });
  const page = await api.readTranscriptHistory(S, { before: 'tail', limit: 3 });
  assert.equal(page.items[0].result, full);
  assert.equal(page.items[0].rawResult, full);
  assert.deepEqual(page.positions, ['h1:0:record-1']);
  const token = `${'a'.repeat(64)}:h1:0:record-1`;
  assert.equal(await api.readTranscriptItem(S, row.id, token), null);
  assert.deepEqual(sent, [
    { method: 'thread/items/list', params: { threadId: S, cursor: { type: 'item', itemId: 'tail' }, sortDirection: 'desc', limit: 3 } },
  ]);
  assert.deepEqual(unclaimed, []);
});

test('a live shell card returns the call body, not its aggregate heading', async () => {
  const id = 'tool-1';
  const body = '1. shell\n  output from the command  \n\n';
  const items = foldRows([
    {
      type: 'toolCall',
      id,
      name: 'shell',
      input: { command: 'example' },
      meta: { status: 'completed' },
      run: { callId: id, live: true, count: 1, result: body, rawResult: body },
    },
  ]);
  assert.match(items[0].rawResult, /^1\. shell\n1\. shell\n/);
  const { api, sent } = adapter({ state: { items } });
  assert.equal(await api.readTranscriptItem(S, id, `${'a'.repeat(64)}:h1:0:old`), null);
  assert.equal((await api.readTranscriptItem(S, id)).rawResult, body);
  assert.deepEqual(sent, [], 'reading a held result does not execute the tool');
});

test('the three start calls answer a blank snapshot for the folder the core names and create no thread', async () => {
  for (const [call, args, method, reply] of [
    ['startTask', [], 'project/taskWorkspace', { path: '/phone/root/task' }],
    ['startProject', ['  /phone/root/p  '], 'project/create', { project: { path: '/phone/root/p' } }],
    ['startProjectTask', ['/phone/root/p'], 'project/directory', { path: '/phone/root/p' }],
  ]) {
    const { api, sent } = adapter({ replies: { [method]: reply, 'project/touch': { project: {} } } });
    const snapshot = await api[call](...args);
    assert.equal(snapshot.cwd, reply.path ?? reply.project.path, call);
    assert.deepEqual(sent.filter((s) => s.method?.startsWith('thread/')), [], `${call}: no thread is created`);
  }
});

test('every snapshot says whether the remote channel is on, from the core\'s remoteSession host state', async () => {
  const replies = { 'project/taskWorkspace': { path: '/phone/root/task' } };
  const off = await adapter({ replies, remoteSession: { sessionId: null } }).api.startTask();
  assert.deepEqual([off.remoteEnabled, off.remoteSessionId], [false, null]);
  const none = await adapter({ replies, remoteSession: undefined }).api.startTask();
  assert.deepEqual([none.remoteEnabled, none.remoteSessionId], [false, null]);
  const on = await adapter({ replies, remoteSession: { sessionId: 'sess_a' } }).api.startTask();
  assert.deepEqual([on.remoteEnabled, on.remoteSessionId], [true, 'sess_a']);
});

test('a start refused by the core fails the call', async () => {
  const { api } = adapter({ replies: { 'project/directory': domainError('pathMissing', '/nope') } });
  await assert.rejects(api.startProject('/nope'));
});

test('an older page is read from the row before it, newest first on the wire, and a newer one from the row after it', async () => {
  const items = [{ type: 'userMessage', id: 'r1', content: [{ type: 'text', text: 'one' }], meta: {} }, { type: 'agentMessage', id: 'r2', text: 'two', meta: {} }];
  const { api, sent } = adapter({ replies: { 'thread/items/list': { data: items, hasOlder: true, hasNewer: false } }, state: { items: [] } });
  const older = await api.readTranscriptHistory(S, { before: 'r3', limit: 2, byteBudget: 4096 });
  assert.deepEqual(older.items.map((r) => [r.id, r.kind, r.text]), [['r1', 'user', 'one'], ['r2', 'assistant', 'two']]);
  assert.deepEqual([older.hasOlder, older.hasNewer], [true, false]);
  assert.equal('positions' in older, false);
  await api.readTranscriptHistory(S, { after: 'r2', limit: 5 });
  assert.deepEqual(sent.map((s) => s.params), [
    { threadId: S, cursor: { type: 'item', itemId: 'r3' }, sortDirection: 'desc', limit: 2, byteBudget: 4096 },
    { threadId: S, cursor: { type: 'item', itemId: 'r2' }, sortDirection: 'asc', limit: 5 },
  ]);
});

test('a row the thread no longer holds returns the reader to the live tail', async () => {
  const { api } = adapter({ replies: { 'thread/items/list': rpcError('cursorInvalidated', { threadId: S }) }, state: { items: [] } });
  assert.deepEqual(await api.readTranscriptHistory(S, { before: 'gone', limit: 5 }), { items: [], hasOlder: false, hasNewer: false, reset: true });
});

test('a malformed history request is refused before anything is sent', async () => {
  const { api, sent } = adapter({ replies: { 'thread/items/list': { data: [] } }, state: { items: [] } });
  for (const bad of [null, {}, { before: 'a', after: 'b', limit: 5 }, { before: '', limit: 5 }, { before: 'a', limit: 0 }, { before: 'a', limit: 513 }, { before: 'a', limit: 1.5 }, { before: 'a', limit: 5, byteBudget: 0 }, { before: 'a', limit: 5, position: 'x' }]) {
    await assert.rejects(api.readTranscriptHistory(S, bad), { name: 'TypeError', message: 'transcript history request is invalid.' }, JSON.stringify(bad));
  }
  assert.deepEqual(sent, []);
});

test('a session this connection does not hold is not paged', async () => {
  const { api, sent } = adapter({});
  await assert.rejects(api.readTranscriptHistory(S, { before: 'r2', limit: 5 }), { message: 'This session is not open on this device.' });
  assert.deepEqual(sent, []);
});

test('a send from a view that misses another device\'s prompt is refused, reaches no core and re-sends the transcript', async () => {
  const latest = [...rows('r1', 'r2'), { id: 'r3', kind: 'user', text: 'from the desktop', device: 'Desktop' }].map((r) => ({ type: 'userMessage', id: r.id, content: [{ type: 'text', text: r.text }], ...(r.device ? { device: r.device } : {}), meta: {} }));
  const replies = { 'thread/items/list': { data: latest, hasOlder: false, hasNewer: false }, 'turn/start': { kind: 'started', turnId: 't1' } };
  const { api, sent } = adapter({ replies, state: { items: rows('r1', 'r2') } });
  await assert.rejects(api.submitToSession(S, 'hello', {}), { message: 'This conversation changed on another device. Review the latest messages, then send again.' });
  assert.equal(sent.some((s) => s.method === 'turn/start'), false);
  assert.equal(sent.filter((s) => s.resume).length, 1);
});

test('a send from a current view goes through, and a prompt of the same device is no news', async () => {
  const same = [{ type: 'userMessage', id: 'r2', content: [{ type: 'text', text: 'mine' }], device: 'Pixel 9', meta: {} }];
  const replies = { 'thread/items/list': { data: same, hasOlder: false, hasNewer: false }, 'turn/start': { kind: 'started', turnId: 't1' } };
  const { api, sent } = adapter({ replies, state: { items: rows('r1') } });
  assert.equal(await api.submitToSession(S, 'hello', {}), true);
  assert.equal(sent.some((s) => s.method === 'turn/start'), true);
});

test('a blank prompt answers false and nothing reaches the core', async () => {
  const { api, sent } = adapter({});
  assert.equal(await api.submitToSession(S, '   ', { id: 'blank' }), false);
  assert.deepEqual(await api.submitNewTask('', { id: 'blank' }, {}), { accepted: false, sessionId: '', snapshot: null });
  assert.deepEqual(sent, []);
});

test('a failure of a real send still throws', async () => {
  const { api } = adapter({ replies: { 'turn/start': domainError('OTHER', 'boom') } });
  await assert.rejects(api.submitToSession(S, 'hi', {}), { message: 'boom' });
});

test('a secret is taken only for a request id the runtime minted', async () => {
  const { api, sent } = adapter({ replies: { 'approval/provideSecret': {} } });
  assert.equal(await api.provideSecretInput('nope', 'v'), false);
  assert.equal(await api.provideSecretInput('secret_abcdef123456', ''), false);
  assert.equal(await api.provideSecretInput('secret_abcdef123456', 'x'.repeat(4097)), false);
  assert.deepEqual(sent, []);
  assert.equal(await api.provideSecretInput(' secret_abcdef123456 ', 'hunter2'), true);
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [['approval/provideSecret', { requestId: 'secret_abcdef123456', secret: 'hunter2' }]]);
});

test('an unknown room action is refused as text and sends nothing', async () => {
  const { api, sent } = adapter({});
  await assert.rejects(api.agentRoomAction('explode', []), { name: 'TypeError', message: 'Unknown room action "explode".' });
  assert.deepEqual(sent, []);
});

test('every request a host call writes is handed the call\'s claim', async () => {
  const latest = [{ type: 'userMessage', id: 'r3', content: [{ type: 'text', text: 'x' }], device: 'Desktop', meta: {} }];
  const replies = {
    'project/taskWorkspace': { path: '/phone/root/task' },
    'thread/items/list': { data: latest, hasOlder: false, hasNewer: false },
    'approval/provideSecret': {},
    'turn/start': { kind: 'started', turnId: 't1' },
  };
  const { api, sent, unclaimed } = adapter({ replies, state: { items: rows('r1') } });
  await api.startTask();
  await api.readTranscriptHistory(S, { before: 'r2', limit: 5 });
  await assert.rejects(api.submitToSession(S, 'hi', {}));
  await api.provideSecretInput('secret_abcdef123456', 'v');
  assert.ok(sent.some((s) => s.resume) && sent.length > 4, 'the stale refusal resumed the thread, and each call wrote');
  assert.deepEqual(unclaimed, []);
});
