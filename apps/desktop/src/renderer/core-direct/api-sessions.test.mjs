// The sessions group over a fake client: every key sends the requests main's IPC handler sent for the same call (the
// shared lanes are the same ones the DesktopServiceClient ran), shapes its answer as the handler did, and the state
// lanes deliver what ipc-state-bridge.ts delivered, minus the wire.
import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { DIRECT_KEYS } from '../../shared/desktop-api-split.ts';
import { createDirectContext } from './context.ts';
import { createRendererConnection } from './renderer-connection.ts';
import { createSessionsApi, sessionLanesOf } from './api-sessions.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const S1 = 'session_1';
const S2 = 'session_2';
const DIGEST = 'a'.repeat(64);

function fakeClient(answer) {
  const calls = [];
  const listeners = new Set();
  const storeListeners = new Set();
  const sections = new Map();
  const folds = new Map();
  return {
    calls,
    sections,
    folds,
    status: { state: 'ready' },
    server: { connection: { device: 'Desk PC' } },
    store: {
      sections: (name) => [...sections.values()].filter((e) => e.section === name),
      section: (name, key) => sections.get(`${name}:${key ?? ''}`) ?? [...sections.values()].find((e) => e.section === name),
      thread: (id) => folds.get(id),
      appFeed: () => ({ epoch: 'e1' }),
      subscribe: (l) => (storeListeners.add(l), () => storeListeners.delete(l)),
    },
    async call(method, params) {
      calls.push({ method, params });
      return answer(method, params);
    },
    notify: () => undefined,
    subscribeApp: async () => undefined,
    resumeThread: async (threadId, window) => {
      calls.push({ method: 'thread/resume', params: { threadId, window } });
      folds.set(threadId, { state: sessionReducer.initial({ thread: { id: threadId }, items: [] }) });
      queueMicrotask(() => storeListeners.forEach((l) => l({ type: 'thread', threadId })));
      return {};
    },
    unsubscribeThread: async (threadId) => void calls.push({ method: 'thread/unsubscribe', params: { threadId } }),
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    close: async () => undefined,
    emitStore: (change) => storeListeners.forEach((l) => l(change)),
  };
}

const defaults = (method) => {
  if (method === 'project/taskWorkspace') return { path: 'C:/task' };
  if (method === 'thread/delete') return {};
  if (method === 'model/list') return [];
  if (method === 'thread/fork') return { thread: { id: S2 }, messages: 1, provider: 'p', model: 'm' };
  if (method === 'desktop/attachment/resolve') return { attachment: { id: DIGEST, mimeType: 'image/png' }, bytes: 3, viewName: 'a.png', dataUrl: 'data:image/png;base64,AAAA' };
  return true;
};

async function opened(answer = defaults) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  const ctx = createDirectContext(connection);
  return { client, ctx, api: createSessionsApi(ctx) };
}
const sent = (client) => client.calls.map((c) => [c.method, c.params]);

test('every key of the group is implemented', async () => {
  const { api } = await opened();
  for (const key of DIRECT_KEYS.sessions) assert.equal(typeof api[key], 'function', key);
  assert.deepEqual(Object.keys(api).sort(), [...DIRECT_KEYS.sessions].sort());
});

test('requests equal what the IPC handlers sent', async () => {
  const cases = [
    ['markSessionRead', [S1, 4, undefined], [['thread/readState/update', { threadId: S1, messageCount: 4, consumedUnread: false }]]],
    ['markSessionRead', [S1, 4, true], [['thread/readState/update', { threadId: S1, messageCount: 4, consumedUnread: true }]]],
    ['searchSessionContent', [' needle '], [['thread/search', { query: 'needle' }]]],
    ['listAgentPool', [], [['agent/pool/list', {}]]],
    ['renameSession', [S1, 'Title'], [['thread/name/set', { threadId: S1, title: 'Title' }]]],
    ['setSessionArchived', [S1, true], [['thread/archive', { threadId: S1 }]]],
    ['setSessionArchived', [S1, false], [['thread/unarchive', { threadId: S1 }]]],
    ['setSessionFavorite', [S1, true], [['thread/metadata/update', { threadId: S1, favorite: true }]]],
    ['setSessionProject', [S1, 'C:/p'], [['thread/metadata/update', { threadId: S1, projectPath: 'C:/p' }]]],
    ['deleteSession', [S1], [['thread/delete', { threadId: S1 }]]],
    ['continueSessionInModel', [S1, { provider: 'p', model: 'm' }], [['thread/continueInModel', { threadId: S1, route: { provider: 'p', model: 'm' } }]]],
    ['scheduleQuotaResume', [S1], [['thread/quotaResume/schedule', { threadId: S1 }]]],
    ['cancelQuotaResume', [S1], [['thread/quotaResume/cancel', { threadId: S1 }]]],
    ['setQuotaAutoResume', [false], [['config/value/write', { path: 'quotaAutoResume', value: false }]]],
    ['getTaskWorkspace', [], [['project/taskWorkspace', {}]]],
    ['openAgentHome', [' bot '], [['agent/home/open', { agentId: 'bot' }]]],
    ['resetAgentHome', ['bot'], [['agent/home/reset', { agentId: 'bot' }]]],
    ['listAgentMemory', ['bot'], [['agent/memory/list', { agentId: 'bot' }]]],
    ['deleteAgentMemory', ['bot', { id: 'm1', indexRevision: 7 }], [['agent/memory/delete', { agentId: 'bot', entryId: 'm1', indexRevision: 7 }]]],
    ['agentRoomAction', ['continue', ['r1']], [['room/continue', { input: { roomId: 'r1' } }]]],
    ['agentRoomAction', ['leave', undefined], [['room/leave', { input: { roomId: undefined } }]]],
    ['listProviderModels', [], [['model/list', {}]]],
    ['listProviderModels', [{ force: true }], [['model/list', { force: true }]]],
    ['setModelRoute', [{ provider: 'p', model: 'm' }, S1], [['route/set', { threadId: S1, route: { provider: 'p', model: 'm' } }]]],
    ['setModelRoute', [{ provider: 'p', model: 'm' }, ''], [['route/set', { route: { provider: 'p', model: 'm' } }]]],
    ['setFast', [true, S1], [['fast/set', { threadId: S1, on: true }]]],
    ['setFast', [false], [['fast/set', { on: false }]]],
    ['submitToSession', [S1, 'hi', { id: 'sub1', priority: 'now', device: 'x' }], [['turn/start', { threadId: S1, input: { prompt: 'hi', options: { priority: 'now', clientSubmissionId: 'sub1' } } }]]],
    ['submitToSession', [S1, 'hi'], [['turn/start', { threadId: S1, input: { prompt: 'hi', options: {} } }]]],
    ['abortSession', [S1, { restorePrompt: true, submissionId: 'x' }], [['turn/interrupt', { threadId: S1, restorePrompt: true, submissionId: 'x' }]]],
    ['abortSession', [S1], [['turn/interrupt', { threadId: S1 }]]],
    ['inheritSession', [S1, null, { compact: true }], [['thread/fork', { threadId: S1, compact: true }], ['thread/resume', { threadId: S2, window: { lastItems: 32 } }]]],
    ['inheritSession', [S1], [['thread/fork', { threadId: S1, compact: false }], ['thread/resume', { threadId: S2, window: { lastItems: 32 } }]]],
  ];
  for (const [key, args, expected] of cases) {
    const { client, api } = await opened();
    await api[key](...args);
    assert.deepEqual(sent(client), expected, `${key}(${JSON.stringify(args)})`);
  }
});

test('answers keep the handlers shapes', async () => {
  const { api } = await opened();
  assert.equal(await api.getTaskWorkspace(), 'C:/task');
  assert.equal(await api.viewerDevice(), 'Desk PC');
  assert.deepEqual(await api.readSessionAttachment(S1, DIGEST), { name: 'a.png', mimeType: 'image/png', size: 3, dataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(await api.getQuotaAutoResume(), true);
  const blank = await opened();
  blank.client.sections.set('x', { section: 'hostState', key: 'x', value: 1 });
  assert.equal(await blank.api.getSnapshot(), null);
});

test('a window the core names no device for shows the default name', async () => {
  const { client, api } = await opened();
  client.server.connection.device = '  ';
  assert.equal(await api.viewerDevice(), 'Main PC');
});

test('attachment read asks the core with the session and the id', async () => {
  const { client, api } = await opened();
  await api.readSessionAttachment(` ${S1} `, DIGEST);
  assert.deepEqual(sent(client), [['desktop/attachment/resolve', { sessionId: S1, attachmentId: DIGEST }]]);
});

test('a standing grant is announced after the approval is accepted, a one-time answer is not', async () => {
  const answer = (method) => (method === 'thread/approval/answer' ? { accepted: true } : defaults(method));
  const ask = [{ id: 'r1', method: 'item/tool/requestApproval', params: { threadId: S1 } }];
  const always = await opened(answer);
  always.client.pendingServerRequests = () => ask;
  assert.equal(await always.api.resolveToolApprovalForSession(S1, ' r1 ', { approved: true, remember: 'always', reply: ' ok ', device: 'x' }), true);
  await tick();
  assert.deepEqual(sent(always.client), [
    ['thread/approval/answer', { threadId: S1, approvalId: 'r1', result: { approved: true, remember: 'always', reply: 'ok' } }],
    ['ui/settings/announce', { scope: 'permissions' }],
  ]);
  const once = await opened(answer);
  once.client.pendingServerRequests = () => ask;
  assert.equal(await once.api.resolveToolApprovalForSession(S1, 'r1', { approved: true, remember: 'once' }), true);
  await tick();
  assert.equal(once.client.calls.some((c) => c.method === 'ui/settings/announce'), false);
});

test('a core failure leaves as the IPC path returned it', async () => {
  const failing = Object.assign(new Error('-32600 domainError'), {
    name: 'ClientError',
    detail: { kind: 'rpc', code: -32600, reason: 'domainError', message: 'domainError', data: { reason: 'domainError', domain: 'x', code: 'ROOM_MEMBER_SWITCHED_OFF', message: 'Off.', detail: { type: 'roomMember', name: 'Bench', count: 1 } } },
  });
  const { api } = await opened(async () => {
    throw failing;
  });
  await assert.rejects(api.searchSessionContent('q'), (e) => e.code === 'ROOM_MEMBER_SWITCHED_OFF' && e.details.name === 'Bench');
});

test('setVisibleSessions follows the visible set and fences an old version', async () => {
  const { client, api } = await opened();
  assert.equal(await api.setVisibleSessions([S1, S2, S1]), true);
  assert.equal(await api.setVisibleSessions([S2]), true);
  const lane = client.calls.filter((c) => /^thread\/(resume|unsubscribe)$/.test(c.method)).map((c) => [c.method, c.params.threadId]);
  assert.deepEqual(lane, [['thread/resume', S1], ['thread/resume', S2], ['thread/unsubscribe', S1]]);
  await assert.rejects(api.setVisibleSessions('nope'), TypeError);
});

const answerRead = (method) => (method === 'thread/read' ? { thread: { id: S2 }, items: [] } : defaults(method));

test('a followed session publishes only while it is visible and is released with a null frame when it leaves', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push([u.sessionId, u.snapshot === null ? null : 'state']));
  await api.setVisibleSessions([S1]);
  await tick();
  assert.deepEqual(seen, [[S1, 'state']]);
  // A thread this window does not show publishes nothing, though its fold changed.
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, [[S1, 'state']]);
  await api.setVisibleSessions([S2]);
  await tick();
  assert.deepEqual(seen, [[S1, 'state'], [S1, null], [S2, 'state']]);
});

test('the frame of a requested read passes the filter and carries the trace id', async () => {
  const { api } = await opened(answerRead);
  const seen = [];
  api.subscribeSessionState((u) => seen.push([u.sessionId, u.frameSource, u.readTraceId]));
  assert.equal(await api.prefetchSession(S2, 12, 'trace-1'), true);
  assert.deepEqual(seen, [[S2, 'replay', 'trace-1']]);
});

test('a prefetch asks the core for the window it names, held at the most a window keeps', async () => {
  const { client, api } = await opened(answerRead);
  await api.prefetchSession(S2, 100000);
  assert.deepEqual(sent(client), [['thread/read', { threadId: S2, window: { lastItems: 8192 } }]]);
});

test('resync delivers the state the window last held and asks the lane for one it holds none of', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u.sessionId));
  await api.setVisibleSessions([S1]);
  await tick();
  api.resyncSessionState(S1);
  assert.deepEqual(seen, [S1, S1]);
  // A session with no held state: the lane is asked once, the answer (any frame) is admitted although the session is hidden.
  api.resyncSessionState(S2);
  api.resyncSessionState(S2);
  client.folds.set(S2, { state: sessionReducer.initial({ thread: { id: S2 }, items: [] }) });
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, [S1, S1, S2]);
  api.resyncSessionState('not a session id');
  assert.equal(seen.length, 3);
});

test('the shell snapshot is what getSnapshot answers and subscribeState delivers', async () => {
  const { ctx, api } = await opened();
  const seen = [];
  const off = api.subscribeState((s) => seen.push(s));
  assert.equal(await api.getSnapshot(), null);
  const blank = { sessionId: '', items: [] };
  sessionLanesOf(ctx).shell.publish(blank);
  assert.equal(await api.getSnapshot(), blank);
  assert.deepEqual(seen, [blank]);
  off();
  sessionLanesOf(ctx).shell.publish(null);
  assert.deepEqual(seen, [blank]);
});

test('subscribeAgentPool delivers the agentPool section rows', async () => {
  const { client, api } = await opened();
  const seen = [];
  const off = api.subscribeAgentPool((rows) => seen.push(rows));
  client.sections.set('agentPool:', { section: 'agentPool', key: null, value: [{ sessionId: S1 }] });
  client.emitStore({ type: 'section', section: 'config' });
  client.emitStore({ type: 'section', section: 'agentPool' });
  assert.deepEqual(seen, [[{ sessionId: S1 }]]);
  off();
  client.emitStore({ type: 'section', section: 'agentPool' });
  assert.equal(seen.length, 1);
});

test('the relay refusal subscription is returned a remover', async () => {
  const { api } = await opened();
  assert.equal(typeof api.subscribeRelayPayloadRefused(() => undefined), 'function');
});

// The patch chain of the removed preload decoder (session-state.test.mjs) is gone: the lane publishes whole states, so a
// window that missed frames, or whose feed was resumed after a gap, is rebuilt from the whole fold, never from a delta.
const folding = (client, id, items) => client.folds.set(id, { state: sessionReducer.initial({ thread: { id }, items }) });
const row = (id, text) => ({ type: 'agentMessage', id, text, meta: {} });

test('a feed resumed after a gap replaces the window state with the whole new fold', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u));
  await api.setVisibleSessions([S1]);
  await tick();
  assert.equal(seen.length, 1);
  const before = seen[0].snapshot.items.length;
  // The library lost frames and folded a fresh snapshot: none of the earlier rows is carried over by a patch.
  folding(client, S1, [row('x1', 'one'), row('x2', 'two')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].frameSource, 'live');
  assert.equal(seen[1].snapshot.items.length, 2);
  assert.notEqual(seen[1].snapshot.items.length, before);
  assert.equal(Object.hasOwn(seen[1].snapshot, '__itemsPatch'), false);
  assert.equal(Object.hasOwn(seen[1].snapshot, '__itemsRevision'), false);
});

test('a resync of a hidden session the fold moved on is answered with the whole current fold, once while it is out', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u));
  folding(client, S2, [row('y1', 'a'), row('y2', 'b'), row('y3', 'c')]);
  // Nothing was published for S2 (hidden): the window holds no state of it, so the request goes to the lane, which reads the fold.
  api.resyncSessionState(S2);
  api.resyncSessionState(S2);
  assert.equal(seen.length, 1, 'the second request coalesces with the one in flight');
  assert.equal(seen[0].sessionId, S2);
  assert.equal(seen[0].snapshot.items.length, 3);
});

test('a resync after the fold changed delivers what the window last showed, and the next frame replaces it whole', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u));
  await api.setVisibleSessions([S1]);
  await tick();
  folding(client, S1, [row('z1', 'first')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  api.resyncSessionState(S1);
  assert.equal(seen.length, 3);
  assert.equal(seen[2].snapshot, seen[1].snapshot, 'the held whole state is delivered again');
  folding(client, S1, [row('z1', 'first'), row('z2', 'second')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.equal(seen[3].snapshot.items.length, 2);
});
