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
  const followed = new Set();
  const restoring = new Set();
  const snapshotPending = new Set();
  const replayPending = new Set();
  const requests = [];
  return {
    calls,
    sections,
    folds,
    restoring,
    snapshotPending,
    replayPending,
    requests,
    status: { state: 'ready' },
    server: { connection: { device: 'Desk PC' } },
    store: {
      sections: (name) => [...sections.values()].filter((e) => e.section === name),
      section: (name, key) =>
        sections.get(`${name}:${key ?? ''}`) ?? [...sections.values()].find((e) => e.section === name),
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
      followed.add(threadId);
      folds.set(threadId, {
        feed: { id: threadId, epoch: 'e1', seq: 1 },
        order: 1,
        state: sessionReducer.initial({ thread: { id: threadId }, items: [] }),
      });
      queueMicrotask(() => storeListeners.forEach((l) => l({ type: 'thread', threadId })));
      return {};
    },
    threadSubscription: (threadId) => ({
      followed: followed.has(threadId),
      held: false,
      restoring: restoring.has(threadId),
      snapshotPending: snapshotPending.has(threadId),
      replayPending: replayPending.has(threadId),
      restoresStarted: 0,
      connection: 1,
    }),
    feedPosition: (threadId) => {
      const fold = folds.get(threadId);
      return fold && { epoch: fold.feed.epoch, seq: fold.feed.seq, order: fold.order };
    },
    unsubscribeThread: async (threadId) => {
      followed.delete(threadId);
      folds.delete(threadId);
      calls.push({ method: 'thread/unsubscribe', params: { threadId } });
    },
    respond: () => undefined,
    pendingServerRequests: () => requests,
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    close: async () => undefined,
    emitStore: (change) => storeListeners.forEach((l) => l(change)),
    emit: (event) => listeners.forEach((l) => l(event)),
  };
}

const defaults = (method, params) => {
  if (method === 'config/value/write') return { values: [params.value] };
  if (method === 'project/taskWorkspace') return { path: 'C:/task' };
  if (method === 'thread/delete') return {};
  if (method === 'model/list') return [];
  if (method === 'thread/fork') return { thread: { id: S2 }, messages: 1, provider: 'p', model: 'm' };
  if (method === 'desktop/attachment/resolve')
    return {
      attachment: { id: DIGEST, mimeType: 'image/png' },
      bytes: 3,
      viewName: 'a.png',
      dataUrl: 'data:image/png;base64,AAAA',
    };
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
    [
      'markSessionRead',
      [S1, 4, undefined],
      [['thread/readState/update', { threadId: S1, messageCount: 4, consumedUnread: false }]],
    ],
    [
      'markSessionRead',
      [S1, 4, true],
      [['thread/readState/update', { threadId: S1, messageCount: 4, consumedUnread: true }]],
    ],
    ['searchSessionContent', [' needle '], [['thread/search', { query: 'needle' }]]],
    ['listAgentPool', [], [['agent/pool/list', {}]]],
    ['renameSession', [S1, 'Title'], [['thread/name/set', { threadId: S1, title: 'Title' }]]],
    ['setSessionArchived', [S1, true], [['thread/archive', { threadId: S1 }]]],
    ['setSessionArchived', [S1, false], [['thread/unarchive', { threadId: S1 }]]],
    ['setSessionFavorite', [S1, true], [['thread/metadata/update', { threadId: S1, favorite: true }]]],
    ['setSessionProject', [S1, 'C:/p'], [['thread/metadata/update', { threadId: S1, projectPath: 'C:/p' }]]],
    ['deleteSession', [S1], [['thread/delete', { threadId: S1 }]]],
    [
      'continueSessionInModel',
      [S1, { provider: 'p', model: 'm' }],
      [['thread/continueInModel', { threadId: S1, route: { provider: 'p', model: 'm' } }]],
    ],
    ['scheduleQuotaResume', [S1], [['thread/quotaResume/schedule', { threadId: S1 }]]],
    ['cancelQuotaResume', [S1], [['thread/quotaResume/cancel', { threadId: S1 }]]],
    ['setQuotaAutoResume', [false], [['config/value/write', { path: 'quotaAutoResume', value: false }]]],
    ['getTaskWorkspace', [], [['project/taskWorkspace', {}]]],
    ['openAgentHome', [' bot '], [['agent/home/open', { agentId: 'bot' }]]],
    ['resetAgentHome', ['bot'], [['agent/home/reset', { agentId: 'bot' }]]],
    ['listAgentMemory', ['bot'], [['agent/memory/list', { agentId: 'bot' }]]],
    [
      'deleteAgentMemory',
      ['bot', { id: 'm1', indexRevision: 7 }],
      [['agent/memory/delete', { agentId: 'bot', entryId: 'm1', indexRevision: 7 }]],
    ],
    ['agentRoomAction', ['continue', ['r1']], [['room/continue', { input: { roomId: 'r1' } }]]],
    ['agentRoomAction', ['leave', undefined], [['room/leave', { input: { roomId: undefined } }]]],
    ['listProviderModels', [], [['model/list', {}]]],
    ['listProviderModels', [{ force: true }], [['model/list', { force: true }]]],
    [
      'submitToSession',
      [S1, 'hi', { id: 'sub1', priority: 'now', device: 'x' }],
      [
        [
          'turn/start',
          { threadId: S1, input: { prompt: 'hi', options: { priority: 'now', clientSubmissionId: 'sub1' } } },
        ],
      ],
    ],
    ['submitToSession', [S1, 'hi'], [['turn/start', { threadId: S1, input: { prompt: 'hi', options: {} } }]]],
    [
      'abortSession',
      [S1, { restorePrompt: true, submissionId: 'x' }],
      [['turn/interrupt', { threadId: S1, restorePrompt: true, submissionId: 'x' }]],
    ],
    ['abortSession', [S1], [['turn/interrupt', { threadId: S1 }]]],
    [
      'inheritSession',
      [S1, null, { compact: true }],
      [
        ['thread/fork', { threadId: S1, compact: true }],
        ['thread/resume', { threadId: S2, window: { lastItems: 32 } }],
      ],
    ],
    [
      'inheritSession',
      [S1],
      [
        ['thread/fork', { threadId: S1, compact: false }],
        ['thread/resume', { threadId: S2, window: { lastItems: 32 } }],
      ],
    ],
  ];
  for (const [key, args, expected] of cases) {
    const { client, api } = await opened();
    await api[key](...args);
    assert.deepEqual(sent(client), expected, `${key}(${JSON.stringify(args)})`);
  }
});

test('setFast returns the addressed conversation, not the blank window shell', async () => {
  const { api, client } = await opened((method, params) => {
    if (method === 'thread/read')
      return { thread: { id: params.threadId }, state: { route: { fast: true } }, items: [] };
    return defaults(method);
  });
  const snapshot = await api.setFast(true, S1);
  assert.equal(snapshot.sessionId, S1);
  assert.equal(snapshot.fast, true);
  assert.deepEqual(sent(client), [
    ['fast/set', { threadId: S1, on: true }],
    ['thread/read', { threadId: S1, window: { none: true } }],
  ]);
});

test('answers keep the handlers shapes', async () => {
  const { api } = await opened();
  assert.equal(await api.getTaskWorkspace(), 'C:/task');
  assert.equal(await api.viewerDevice(), 'Desk PC');
  assert.deepEqual(await api.readSessionAttachment(S1, DIGEST), {
    name: 'a.png',
    mimeType: 'image/png',
    size: 3,
    dataUrl: 'data:image/png;base64,AAAA',
  });
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
  assert.equal(
    await always.api.resolveToolApprovalForSession(S1, ' r1 ', {
      approved: true,
      remember: 'always',
      reply: ' ok ',
      device: 'x',
    }),
    true
  );
  await tick();
  assert.deepEqual(sent(always.client), [
    [
      'thread/approval/answer',
      { threadId: S1, approvalId: 'r1', result: { approved: true, remember: 'always', reply: 'ok' } },
    ],
    ['ui/settings/announce', { scope: 'permissions' }],
  ]);
  const once = await opened(answer);
  once.client.pendingServerRequests = () => ask;
  assert.equal(await once.api.resolveToolApprovalForSession(S1, 'r1', { approved: true, remember: 'once' }), true);
  await tick();
  assert.equal(
    once.client.calls.some((c) => c.method === 'ui/settings/announce'),
    false
  );
});

test('a core failure leaves as the IPC path returned it', async () => {
  const failing = Object.assign(new Error('-32600 domainError'), {
    name: 'ClientError',
    detail: {
      kind: 'rpc',
      code: -32600,
      reason: 'domainError',
      message: 'domainError',
      data: {
        reason: 'domainError',
        domain: 'x',
        code: 'ROOM_MEMBER_SWITCHED_OFF',
        message: 'Off.',
        detail: { type: 'roomMember', name: 'Bench', count: 1 },
      },
    },
  });
  const { api } = await opened(async () => {
    throw failing;
  });
  await assert.rejects(
    api.searchSessionContent('q'),
    (e) => e.code === 'ROOM_MEMBER_SWITCHED_OFF' && e.details.name === 'Bench'
  );
});

test('setVisibleSessions follows the visible set and fences an old version', async () => {
  const { client, api } = await opened();
  assert.equal(await api.setVisibleSessions([S1, S2, S1]), true);
  assert.equal(await api.setVisibleSessions([S2]), true);
  const lane = client.calls
    .filter((c) => /^thread\/(resume|unsubscribe)$/.test(c.method))
    .map((c) => [c.method, c.params.threadId]);
  assert.deepEqual(lane, [
    ['thread/resume', S1],
    ['thread/resume', S2],
    ['thread/unsubscribe', S1],
  ]);
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
  assert.deepEqual(seen, [
    [S1, 'state'],
    [S1, null],
    [S2, 'state'],
  ]);
});

test('a session whose registration went empty and back is delivered again: a new baseline, then live frames', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push([u.sessionId, u.snapshot === null ? null : 'state']));
  await api.setVisibleSessions([S1]);
  await tick();
  assert.deepEqual(seen, [[S1, 'state']]);
  // The empty set releases the window's baseline at once and the lane lets S1 go; showing it again resumes it.
  await Promise.all([api.setVisibleSessions([]), api.setVisibleSessions([S1])]);
  await tick();
  assert.deepEqual(seen.slice(0, 2), [
    [S1, 'state'],
    [S1, null],
  ]);
  assert.deepEqual(seen.at(-1), [S1, 'state'], 'the shown session has a state again');
  // Live frames reach it.
  const delivered = seen.length;
  folding(client, S1, [row('m1', 'live')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.equal(seen.length, delivered + 1);
});

test('showing an already followed session delivers its hidden fold without another resume', async () => {
  const { client, api } = await opened();
  await client.resumeThread(S2, { lastItems: 32 });
  client.calls.length = 0;
  const seen = [];
  api.subscribeSessionState((update) => seen.push(update));
  folding(client, S2, [row('held', 'already followed')]);
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, []);
  await api.setVisibleSessions([S2]);
  await api.setVisibleSessions([S2]);
  assert.deepEqual(
    seen.map(({ frameSource, snapshot }) => [frameSource, snapshot.items[0].id]),
    [['live', 'held']]
  );
  assert.deepEqual(sent(client), []);
});

test('opening during a current-cursor restore delivers the held state once when the restore settles', async () => {
  const { client, api } = await opened();
  await client.resumeThread(S2, { lastItems: 32 });
  folding(client, S2, [row('held', 'no newer events')]);
  client.calls.length = 0;
  client.restoring.add(S2);
  const seen = [];
  api.subscribeSessionState((update) => seen.push(update.snapshot.items[0].id));
  await api.setVisibleSessions([S2]);
  assert.deepEqual(seen, []);
  client.restoring.delete(S2);
  client.emitStore({ type: 'subscription', feedId: S2, state: 'restored' });
  assert.deepEqual(seen, ['held']);
  assert.deepEqual(sent(client), []);
});

test('re-entering before unsubscribe settles delivers the replacement snapshot, not the old fold first', async () => {
  const { client, api } = await opened();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const unsubscribe = client.unsubscribeThread;
  client.unsubscribeThread = async (id) => {
    started.resolve();
    await release.promise;
    await unsubscribe(id);
  };
  const seen = [];
  const arrived = Promise.withResolvers();
  api.subscribeSessionState(({ snapshot }) => {
    seen.push(snapshot ? snapshot.items.map(({ id }) => id) : null);
    if (seen.length === 3) arrived.resolve();
  });
  await api.setVisibleSessions([S1]);
  await tick();
  await api.setVisibleSessions([]);
  await started.promise;
  await api.setVisibleSessions([S1]);
  folding(client, S1, [row('old', 'from the closing subscription')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.deepEqual(seen, [[], null]);
  release.resolve();
  await arrived.promise;
  assert.deepEqual(seen, [[], null, []]);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['thread/resume', 'thread/unsubscribe', 'thread/resume']
  );
});

test('an approval during snapshot restore is delivered with the replacement transcript, not the old fold', async () => {
  const { client, api } = await opened();
  await client.resumeThread(S2, { lastItems: 32 });
  folding(client, S2, [row('old', 'before reconnect')]);
  client.calls.length = 0;
  client.restoring.add(S2);
  const seen = [];
  api.subscribeSessionState(({ snapshot }) => seen.push([snapshot.items[0].id, snapshot.toolApproval]));
  await api.setVisibleSessions([S2]);
  client.restoring.delete(S2);
  client.snapshotPending.add(S2);
  client.emitStore({ type: 'subscription', feedId: S2, state: 'restored' });
  const approval = { kind: 'shell', command: 'ls' };
  client.requests.push({
    id: 7,
    method: 'item/tool/requestApproval',
    params: { threadId: S2, order: 1, card: approval },
  });
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, []);
  folding(client, S2, [row('fresh', 'after reconnect')]);
  client.snapshotPending.delete(S2);
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, [['fresh', approval]]);
  assert.deepEqual(sent(client), []);
});

test('opening during a missed-event replay delivers only the transcript at the replay boundary', async () => {
  const { client, api } = await opened();
  await client.resumeThread(S2, { lastItems: 32 });
  folding(client, S2, [row('old', 'before reconnect')]);
  client.calls.length = 0;
  client.restoring.add(S2);
  const seen = [];
  api.subscribeSessionState(({ snapshot }) => seen.push(snapshot.items.map(({ id }) => id)));
  await api.setVisibleSessions([S2]);
  client.restoring.delete(S2);
  client.replayPending.add(S2);
  client.emitStore({ type: 'subscription', feedId: S2, state: 'restored' });
  folding(client, S2, [row('partial', 'still replaying')]);
  client.emitStore({ type: 'thread', threadId: S2 });
  assert.deepEqual(seen, []);
  folding(client, S2, [row('restored', 'caught up')]);
  client.replayPending.delete(S2);
  client.emitStore({ type: 'thread', threadId: S2, replayComplete: true });
  assert.deepEqual(seen, [['restored']]);
  assert.deepEqual(sent(client), []);
});

test('cache-only resync redelivers the visible baseline with its position and never reads an unfollowed thread', async () => {
  const { client, api } = await opened();
  const seen = [];
  const arrived = Promise.withResolvers();
  api.subscribeSessionState((frame) => {
    seen.push(frame);
    arrived.resolve();
  });
  await api.setVisibleSessions([S1]);
  await arrived.promise;
  api.resyncSessionState(S1, { cachedOnly: true });
  api.resyncSessionState(S2, { cachedOnly: true });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0]);
  assert.ok(seen[1].streamPosition);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['thread/resume']
  );
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
  client.folds.set(S2, {
    feed: { id: S2, epoch: 'e1', seq: 1 },
    order: 1,
    state: sessionReducer.initial({ thread: { id: S2 }, items: [] }),
  });
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

test('the core announcing a refused relay frame reaches the subscriber until it is removed', async () => {
  const { client, api } = await opened();
  const seen = [];
  const off = api.subscribeRelayPayloadRefused((detail) => seen.push(detail));
  const announce = (params) =>
    client.emit({ type: 'notification', notification: { method: 'ui/relayPayloadRefused', params } });
  announce({ bytes: 70000000, limit: 67108864 });
  announce({ bytes: null });
  client.emit({ type: 'notification', notification: { method: 'ui/settings/changed', params: { scope: 'x' } } });
  assert.deepEqual(seen, [
    { bytes: 70000000, limit: 67108864 },
    { bytes: null, limit: null },
  ]);
  off();
  announce({ bytes: 1, limit: 2 });
  assert.equal(seen.length, 2);
});

test('a session state that left the baseline unchanged is not delivered again, a changed one is', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u.sessionId));
  await api.setVisibleSessions([S1]);
  await tick();
  assert.equal(seen.length, 1);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.equal(seen.length, 1);
  // A resync starts from no baseline: the window gets the state again.
  api.resyncSessionState(S1);
  assert.equal(seen.length, 2);
  folding(client, S1, [row('r1', 'hello')]);
  client.emitStore({ type: 'thread', threadId: S1 });
  assert.equal(seen.length, 3);
});

test('a fresh resync republishes the held fold at once, with no transcript read, and is not a replay of the cached frame', async () => {
  const { client, api } = await opened();
  const seen = [];
  api.subscribeSessionState((u) => seen.push(u.sessionId));
  await api.setVisibleSessions([S1]);
  await tick();
  assert.equal(seen.length, 1);
  const calls = client.calls?.length ?? 0;
  assert.equal(await api.resyncSessionState(S1, { fresh: true }), true);
  assert.equal(seen.length, 2, 'the unchanged state is published again, from the fold');
  assert.equal(client.calls?.length ?? 0, calls, 'nothing was fetched');
});

test('an engine state that left the baseline unchanged is not delivered again', async () => {
  const { ctx, api } = await opened();
  const seen = [];
  api.subscribeState((s) => seen.push(s));
  const { shell } = sessionLanesOf(ctx);
  shell.publish({ sessionId: 'a', items: [] });
  shell.publish({ sessionId: 'a', items: [] });
  shell.publish({ sessionId: 'b', items: [] });
  assert.deepEqual(
    seen.map((s) => s.sessionId),
    ['a', 'b']
  );
});

test('sessions that leave the visible set are logged as released baselines', async () => {
  const { api } = await opened();
  const logged = [];
  const original = console.info;
  const originalError = console.error;
  const errors = [];
  console.info = (line) => logged.push(String(line));
  console.error = (line) => errors.push(String(line));
  try {
    await api.setVisibleSessions([S1]);
    await tick();
    await api.setVisibleSessions([S2]);
  } finally {
    console.info = original;
    console.error = originalError;
  }
  assert.deepEqual(errors, [], 'a routine release is not a console error');
  assert.equal(
    logged.filter((line) => line.startsWith('[mixdog-lane] baseline released count=1 visible=1 ids=')).length,
    1
  );
});

// The patch chain of the removed preload decoder (session-state.test.mjs) is gone: the lane publishes whole states, so a
// window that missed frames, or whose feed was resumed after a gap, is rebuilt from the whole fold, never from a delta.
const folding = (client, id, items) =>
  client.folds.set(id, {
    feed: { id, epoch: 'e1', seq: 1 },
    order: 1,
    state: sessionReducer.initial({ thread: { id }, items }),
  });
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

test('a favorite is sent for the trimmed session id with the boolean as given', async () => {
  const { client, api } = await opened();
  await api.setSessionFavorite(` ${S1} `, false);
  assert.deepEqual(sent(client), [['thread/metadata/update', { threadId: S1, favorite: false }]]);
});
