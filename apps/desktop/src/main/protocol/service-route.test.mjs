// The DesktopService methods as core requests (service-route.ts): the exact op and params each converted method
// sends, the methods with no op (refused before anything is sent), and the client's wiring. Expected values are
// written from the Rust params (`client_methods.json`), not from the router; every param sent must be a property of
// the op's schema.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';
import { createChatApi, sharedFor } from '../../renderer/remote-protocol-chat.ts';
import { DesktopServiceClient } from '../desktop-service-client.ts';
import { createCapabilityLane } from './capability-route.ts';
import { FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_MS, SERVICE_NOT_ROUTED, createServiceLane } from './service-route.ts';

const schemaDir = new URL('../../../../../native/core/crates/mixdog-app-protocol/schema/', import.meta.url);
const clientMethods = JSON.parse(readFileSync(new URL('client_methods.json', schemaDir), 'utf8'));
const paramsSchema = (method) => clientMethods.definitions[clientMethods.methods[method].params.$ref.split('/').pop()];

const protocolOptions = JSON.parse(
  readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const HELD = { held: true };

/** The library's thread calls of a connection whose requests are `call`'s: they are recorded as the requests they send. */
const threadCalls = (call) => ({
  resumeThread: (threadId, window) => call('thread/resume', { threadId, window }),
  unsubscribeThread: (threadId) => call('thread/unsubscribe', { threadId }),
});

// A project path resolves to its folder first (project/directory); the task workspace has its own folder; the project list is
// empty; everything else answers ok. A file search completes with no file as soon as its query is taken.
function lane(
  answer = async (method) =>
    method === 'project/directory'
      ? { path: '/resolved' }
      : method === 'project/taskWorkspace'
        ? { path: '/workspace' }
        : method === 'project/list'
          ? { projects: [] }
          : { ok: true }
) {
  const calls = [];
  const notified = [];
  const listeners = new Set();
  const emit = (method, params) => {
    for (const listener of [...listeners]) listener({ type: 'notification', notification: { method, params } });
  };
  const call = async (method, params) => {
    calls.push({ method, params });
    const reply = await answer(method, params);
    if (method === 'search/update') emit('search/completed', { sessionId: params.sessionId, query: params.query });
    return reply;
  };
  const service = createServiceLane({
    protocol: {
      call,
      ...threadCalls(call),
      notify: (method, params) => notified.push({ method, params }),
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    snapshot: () => HELD,
  });
  return { calls, notified, service, emit };
}

const route = { provider: 'p', model: 'm' };
const draft = { projectPath: '/proj', workflowId: 'w' };
const prompt = [{ type: 'text', text: 'hi' }];

// [method, args, expected requests]
const CASES = [
  [
    'submitNewTask',
    [prompt, { id: 's1', displayText: 'd', device: 'x', hop: 2 }, draft],
    [
      [
        'thread/start',
        {
          kind: 'task',
          projectPath: '/proj',
          draft,
          initialInput: { prompt, options: { displayText: 'd', clientSubmissionId: 's1' } },
        },
      ],
    ],
  ],
  ['listProjects', [], [['project/list', {}]]],
  ['addProject', ['/p'], [['project/create', { path: '/p' }]]],
  ['projectDirectory', ['/p'], [['project/directory', { path: '/p' }]]],
  ['projectRecoveryDirectory', ['/p'], [['project/recoveryDirectory', { path: '/p' }]]],
  ['renameProject', ['/p', 'al'], [['project/update', { path: '/p', alias: 'al' }]]],
  ['removeProject', ['/p'], [['project/delete', { path: '/p' }]]],
  ['getTaskWorkspace', [], [['project/taskWorkspace', {}]]],
  ['codeGraphQuery', ['/p', 'symbols', 'q'], [['project/directory', { path: '/p' }], ['project/codeGraph', { path: '/resolved', mode: 'symbols', query: 'q' }]]],
  ['listProjectDir', ['/p', 'a'], [['project/directory', { path: '/p' }], ['projectFs/listDir', { root: '/resolved', rel: 'a' }]]],
  ['readProjectTextFile', ['/p', 'a.txt'], [['project/directory', { path: '/p' }], ['projectFs/readText', { root: '/resolved', rel: 'a.txt' }]]],
  [
    'writeProjectTextFile',
    ['/p', 'a.txt', 'new', 'old', 'utf16le'],
    [['project/directory', { path: '/p' }], ['projectFs/writeText', { root: '/resolved', rel: 'a.txt', content: 'new', expectedContent: 'old', encoding: 'utf16le' }]],
  ],
  [
    'writeProjectTextFile',
    ['/p', 'a.txt', 'new', 'old'],
    [['project/directory', { path: '/p' }], ['projectFs/writeText', { root: '/resolved', rel: 'a.txt', content: 'new', expectedContent: 'old' }]],
  ],
  ['statProjectFile', ['/p', 'a'], [['project/directory', { path: '/p' }], ['projectFs/stat', { root: '/resolved', rel: 'a' }]]],
  [
    'createProjectEntry',
    ['/p', 'd', 'n', true],
    [['project/directory', { path: '/p' }], ['projectFs/create', { root: '/resolved', relDir: 'd', name: 'n', directory: true }]],
  ],
  ['renameProjectEntry', ['/p', 'a', 'b'], [['project/directory', { path: '/p' }], ['projectFs/rename', { root: '/resolved', rel: 'a', newName: 'b' }]]],
  ['moveProjectEntry', ['/p', 'a', 'd'], [['project/directory', { path: '/p' }], ['projectFs/move', { root: '/resolved', rel: 'a', targetDirRel: 'd' }]]],
  ['copyProjectEntry', ['/p', 'a', 'd'], [['project/directory', { path: '/p' }], ['projectFs/copy', { root: '/resolved', rel: 'a', targetDirRel: 'd' }]]],
  ['projectEntryPath', ['/p', 'a'], [['project/directory', { path: '/p' }], ['projectFs/entryPath', { root: '/resolved', rel: 'a' }]]],
  [
    'markSessionRead',
    ['t1', 7, false],
    [['thread/readState/update', { threadId: 't1', messageCount: 7, consumedUnread: false }]],
  ],
  ['searchSessionContent', ['needle'], [['thread/search', { query: 'needle' }]]],
  ['listAgentPool', [], [['agent/pool/list', {}]]],
  ['renameSession', ['t1', 'T'], [['thread/name/set', { threadId: 't1', title: 'T' }]]],
  ['continueSessionInModel', ['t1', route], [['thread/continueInModel', { threadId: 't1', route }]]],
  ['scheduleQuotaResume', ['t1'], [['thread/quotaResume/schedule', { threadId: 't1' }]]],
  ['cancelQuotaResume', ['t1'], [['thread/quotaResume/cancel', { threadId: 't1' }]]],
  ['stopShellJob', ['t1', 'j1'], [['thread/backgroundTerminals/terminate', { threadId: 't1', taskId: 'j1' }]]],
  ['releaseShellJob', ['t1', 'j1'], [['thread/backgroundTerminals/release', { threadId: 't1', taskId: 'j1' }]]],
  ['setQuotaAutoResume', [false], [['config/value/write', { path: 'quotaAutoResume', value: false }]]],
  [
    'readSessionFinalAnswer',
    ['t1', 123],
    [['thread/finalAnswer/read', { threadId: 't1', startedAt: 123 }]],
  ],
  ['prefetchSession', ['t1', 64, 'trace'], [['thread/read', { threadId: 't1', window: { lastItems: 64 } }]]],
  ['prefetchSession', ['t1'], [['thread/read', { threadId: 't1', window: { lastItems: 32 } }]]],
  ['setSessionFavorite', ['t1', true], [['thread/metadata/update', { threadId: 't1', favorite: true }]]],
  ['setSessionProject', ['t1', '/p'], [['thread/metadata/update', { threadId: 't1', projectPath: '/p' }]]],
  ['setSessionArchived', ['t1', true], [['thread/archive', { threadId: 't1' }]]],
  ['setSessionArchived', ['t1', false], [['thread/unarchive', { threadId: 't1' }]]],
  ['deleteSession', ['t1'], [['thread/delete', { threadId: 't1' }]]],
  [
    'submitToSession',
    ['sess_room_abc123', 'hi', { id: 'sub-1', pastedTexts: { 1: { id: 1, text: 'x' } } }],
    [
      [
        'room/send',
        {
          input: {
            threadId: 'sess_room_abc123',
            prompt: 'hi',
            options: { pastedTexts: { 1: { id: 1, text: 'x' } }, clientSubmissionId: 'sub-1' },
          },
        },
      ],
    ],
  ],
  ['openAgentHome', ['a1'], [['agent/home/open', { agentId: 'a1' }]]],
  ['resetAgentHome', ['a1'], [['agent/home/reset', { agentId: 'a1' }]]],
  ['listAgentMemory', ['a1'], [['agent/memory/list', { agentId: 'a1' }]]],
  [
    'deleteAgentMemory',
    ['a1', { id: 4, indexRevision: 'r' }],
    [['agent/memory/delete', { agentId: 'a1', entryId: 4, indexRevision: 'r' }]],
  ],
  [
    'agentRoomAction',
    ['create', [{ name: 'n', members: ['a'] }]],
    [['room/create', { input: { name: 'n', members: ['a'] } }]],
  ],
  [
    'agentRoomAction',
    ['update', ['r1', { name: 'n2', maxRounds: 3 }]],
    [['room/update', { input: { roomId: 'r1', name: 'n2', maxRounds: 3 } }]],
  ],
  ['agentRoomAction', ['leave', ['r1']], [['room/leave', { input: { roomId: 'r1' } }]]],
  ['agentRoomAction', ['remove', ['r1']], [['room/remove', { input: { roomId: 'r1' } }]]],
  ['agentRoomAction', ['reset', ['r1']], [['room/reset', { input: { roomId: 'r1' } }]]],
  [
    'inheritSession',
    ['t1', route, { compact: true }],
    [['thread/fork', { threadId: 't1', route, compact: true }]],
  ],
  ['inheritSession', ['t1', null, null], [['thread/fork', { threadId: 't1' }]]],
  [
    'submitToSession',
    ['t1', 'text', { id: 'sub1', priority: 'next' }],
    [['turn/start', { threadId: 't1', input: { prompt: 'text', options: { priority: 'next', clientSubmissionId: 'sub1' } } }]],
  ],
  [
    'abortSession',
    ['t1', { restorePrompt: true, submissionId: 'sub1', device: 'x' }],
    [['turn/interrupt', { threadId: 't1', restorePrompt: true, submissionId: 'sub1' }]],
  ],
  ['listProviderModels', [{ force: true, quick: false }], [['model/list', { force: true, quick: false }]]],
  ['setFast', [true, 't1'], [['fast/set', { threadId: 't1', on: true }]]],
  [
    'searchProjectFiles',
    ['/p', 'q', 50, false, true, 'mention'],
    [
      ['search/start', { sessionId: 'search:mention', roots: ['/p'], limit: 50, includeIgnored: false, includeDirectories: true, consumer: 'mention' }],
      ['search/update', { sessionId: 'search:mention', query: 'q' }],
    ],
  ],
];

for (const [method, args, expected] of CASES) {
  test(`${method} sends ${expected.map(([op]) => op).join(' + ')} with the declared params`, async () => {
    const { calls, service } = lane();
    await service.call(method, args);
    assert.deepEqual(
      calls,
      expected.map(([op, params]) => ({ method: op, params }))
    );
    for (const { method: op, params } of calls) {
      const schema = paramsSchema(op);
      for (const key of Object.keys(params)) assert.ok(key in schema.properties, `${op}: ${key} is not a param`);
      for (const key of schema.required ?? []) {
        if (key !== 'opId') assert.ok(key in params, `${op}: ${key} is required`);
      }
    }
  });
}

test('the snapshot-returning methods answer with the held snapshot, the others with the core reply', async () => {
  const { service } = lane(async () => ({ reply: 1 }));
  assert.equal(await service.call('setFast', [true]), HELD);
  assert.deepEqual(await service.call('listAgentPool', []), { reply: 1 });
});

// Node's host sent `applyToCurrentSession: true, keepMainModel: Boolean(sessionId)` with every pick and answered the session's
// state after it; the state is the core's thread state, where a clamped effort is the effective one (`ultra` asked, `high` held).
test('setModelRoute writes the pick as Node sent it and answers the thread state the core holds after it', async () => {
  const calls = [];
  const protocol = {
    snapshot: () => ({ status: 'ready', entries: [] }),
    noteUserInput() {},
    pendingServerRequests: () => [],
    onEvent: () => () => {},
    client: () => ({ threadSubscription: () => ({ held: true }) }),
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'control-1' } };
      if (method === 'thread/read') {
        const state = { route: { provider: 'p', model: 'm', effort: 'high', effortOptions: [] } };
        return { thread: { id: params.threadId }, state, items: [], hasOlder: false };
      }
      return { provider: 'p', model: 'm', effort: 'ultra', effectiveEffort: 'high' };
    },
  };
  const client = new DesktopServiceClient({ capabilityLane: createCapabilityLane({ protocol }) });
  const pick = { ...route, effort: 'ultra' };
  const addressed = await client.setModelRoute(pick, 't1');
  assert.equal(addressed.effort, 'high');
  assert.deepEqual(calls.filter(({ method }) => method === 'route/set'), [
    { method: 'route/set', params: { threadId: 't1', route: { ...pick, applyToCurrentSession: true, keepMainModel: true } } },
  ]);
  calls.length = 0;
  const main = await client.setModelRoute(pick);
  assert.equal(main.effort, 'high');
  assert.deepEqual(calls.filter(({ method }) => method === 'route/set'), [
    { method: 'route/set', params: { threadId: 'control-1', route: { ...pick, applyToCurrentSession: true, keepMainModel: false } } },
  ]);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Lets every request answered at once, and what the lane does after it, run to its end. */
const settled = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

/** The threads a run of requests leaves followed, replayed in the order they were sent. */
const followedAfter = (calls) => {
  const followed = new Set();
  for (const { method, params } of calls) {
    if (method === 'thread/resume') followed.add(params.threadId);
    if (method === 'thread/unsubscribe') followed.delete(params.threadId);
  }
  return [...followed].sort();
};

test('setVisibleSessions resumes the new visible threads and unsubscribes the ones that left', async () => {
  const { calls, service } = lane();
  assert.equal(await service.call('setVisibleSessions', [['a', 'b'], 1]), true);
  await settled();
  assert.equal(await service.call('setVisibleSessions', [['b', 'c'], 2]), true);
  await settled();
  assert.deepEqual(calls, [
    { method: 'thread/resume', params: { threadId: 'a', window: { lastItems: 32 } } },
    { method: 'thread/resume', params: { threadId: 'b', window: { lastItems: 32 } } },
    { method: 'thread/unsubscribe', params: { threadId: 'a' } },
    { method: 'thread/resume', params: { threadId: 'c', window: { lastItems: 32 } } },
  ]);
});

test('a visible set older than or equal to the newest one sent changes nothing; an unversioned one applies', async () => {
  const { calls, service } = lane();
  await service.call('setVisibleSessions', [['a'], 2]);
  await settled();
  assert.equal(await service.call('setVisibleSessions', [['b'], 1]), true);
  assert.equal(await service.call('setVisibleSessions', [['b'], 2]), true);
  await settled();
  assert.deepEqual(calls.map((call) => [call.method, call.params.threadId]), [['thread/resume', 'a']]);
  await service.call('setVisibleSessions', [['c']]);
  await assert.rejects(service.call('setVisibleSessions', [['d'], 0]), /visible session version/);
  await settled();
  assert.deepEqual(calls.map((call) => [call.method, call.params.threadId]), [['thread/resume', 'a'], ['thread/unsubscribe', 'a'], ['thread/resume', 'c']]);
});

const failure = (reason) =>
  reason === 'threadNotFound'
    ? Object.assign(new Error('gone'), { detail: { kind: 'rpc', code: -32600, data: { reason } } })
    : reason === 'connectionLost'
      ? Object.assign(new Error('lost'), { detail: { kind: 'connectionLost' } })
      : Object.assign(new Error('bad'), { detail: { kind: 'rpc', code: -32603 } });

/**
 * A core modeled as the thread subscriptions each of its connections holds, under a client shaped as the library's: it
 * follows a thread once a resume is answered, stops following before an unsubscribe goes out, and after its own reconnect
 * announces `ready` first and then restores what it follows, each restore a request of its own that the core applies when it
 * answers it (so an unsubscribe answered before a queued restore cannot remove what that restore attaches). It says what it
 * follows and what it is restoring (`threadSubscription`). `answer(method, threadId, client)` decides each request
 * ('thread/resume', 'thread/unsubscribe', or 'restore'): 'ok', 'fail', 'unavailable' (`threadNotFound`), or 'hold' (settled
 * later through `held`). With `defer`, the connection reaches the client a microtask after the lane's call, as the renderer's
 * does. The retry timers are the test's: `timers` holds the pending ones and `fire()` runs them.
 */
function modeled(answer = () => 'ok', { defer = false, report } = {}) {
  const held = [];
  const sent = [];
  const timers = new Set();
  const replacedListeners = new Set();
  const eventListeners = new Set();
  const storeListeners = new Set();
  const emitEvent = (event) => eventListeners.forEach((listener) => listener(event));
  const emitStore = (change) => storeListeners.forEach((listener) => listener(change));
  let clients = 0;
  let client;
  const open = () => {
    const opened = { id: ++clients, status: { state: 'ready' }, connection: 1, subs: new Set(), restoring: new Map(), core: new Set(), closed: false };
    opened.restores = 0;
    opened.threadSubscription = (threadId) => ({
      followed: opened.subs.has(threadId),
      restoring: opened.restoring.has(threadId),
      restoresStarted: opened.restores,
      connection: opened.connection,
    });
    const request = (method, threadId) => {
      sent.push([opened.id, method, threadId]);
      const connection = opened.connection;
      // The core applies a request when it answers it; an answer never crosses a connection or a closed client.
      const apply = (outcome) => {
        if (opened.closed || opened.connection !== connection) throw failure('connectionLost');
        if (outcome !== 'ok') throw failure(outcome === 'unavailable' ? 'threadNotFound' : 'internal');
        if (method === 'thread/unsubscribe') opened.core.delete(threadId);
        else opened.core.add(threadId);
        // The library's resume follows the thread; its restore only re-attaches the feed.
        if (method === 'thread/resume') opened.subs.add(threadId);
      };
      const outcome = answer(method, threadId, opened);
      if (outcome !== 'hold') return Promise.resolve().then(() => apply(outcome));
      return new Promise((resolve, reject) =>
        held.push({
          method,
          threadId,
          client: opened,
          settle(result = 'ok') {
            held.splice(held.indexOf(this), 1);
            try {
              resolve(apply(result));
            } catch (error) {
              reject(error);
            }
          },
        })
      );
    };
    /** The library's `restoreThread`: the end of the restore is the `subscription` store change, restored or lost. */
    opened.restore = (threadId) => {
      const token = {};
      opened.restoring.set(threadId, token);
      opened.restores += 1;
      const done = () => {
        if (opened.restoring.get(threadId) === token) opened.restoring.delete(threadId);
      };
      const owned = () => opened === client;
      request('restore', threadId).then(
        () => {
          done();
          if (owned()) emitStore({ type: 'subscription', feedId: threadId, state: 'restored' });
        },
        (error) => {
          done();
          if (error.detail.kind !== 'rpc') return;
          opened.subs.delete(threadId);
          if (!owned()) return;
          emitEvent({ type: 'subscriptionLost', threadId, error: error.detail });
          emitStore({ type: 'subscription', feedId: threadId, state: 'lost' });
        }
      );
    };
    opened.resumeThread = (threadId) => request('thread/resume', threadId);
    opened.unsubscribeThread = (threadId) => {
      opened.subs.delete(threadId);
      return request('thread/unsubscribe', threadId);
    };
    return opened;
  };
  client = open();
  const reach = async () => {
    if (defer) await null;
    return client;
  };
  const protocol = {
    call: async () => ({}),
    notify: () => undefined,
    client: () => client,
    resumeThread: async (threadId, window) => (await reach()).resumeThread(threadId, window),
    unsubscribeThread: async (threadId) => (await reach()).unsubscribeThread(threadId),
    onEvent: (listener) => (eventListeners.add(listener), () => eventListeners.delete(listener)),
    onReplaced: (listener) => (replacedListeners.add(listener), () => replacedListeners.delete(listener)),
    onStoreChange: (listener) => (storeListeners.add(listener), () => storeListeners.delete(listener)),
  };
  const schedule = (run, ms) => {
    const timer = { run, ms };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  const service = createServiceLane({ protocol, snapshot: () => HELD, schedule, ...(report ? { report } : {}) });
  return {
    service,
    held,
    sent,
    timers,
    protocol,
    listeners: () => eventListeners.size + replacedListeners.size + storeListeners.size,
    current: () => client,
    show: (ids, version) => service.call('setVisibleSessions', [ids, version]),
    /** The request held for `threadId` (the oldest one). */
    take: (method, threadId) => held.find((entry) => entry.method === method && entry.threadId === threadId),
    /** A reopen: the old client is closed, a new one is attached, then the lane is told. */
    replace() {
      client.closed = true;
      client = open();
      for (const listener of [...replacedListeners]) listener();
    },
    /** The client's own reconnect: a new transport connection holding nothing, `ready`, then a restore of each followed thread. */
    reconnect() {
      client.connection += 1;
      client.core = new Set();
      emitEvent({ type: 'status', status: { state: 'ready' } });
      for (const threadId of [...client.subs]) client.restore(threadId);
    },
    fire() {
      const due = [...timers];
      timers.clear();
      for (const timer of due) timer.run();
      return due.map((timer) => timer.ms);
    },
  };
}
/** The core feeds the current connection exactly `ids`, and the client follows exactly those. */
const assertConverged = (m, ids, message) => {
  assert.deepEqual([...m.current().core].sort(), [...ids].sort(), `${message ?? ''} (core)`);
  assert.deepEqual([...m.current().subs].sort(), [...ids].sort(), `${message ?? ''} (client)`);
};

test('a hide followed at once by a show ends subscribed, and a show followed by a hide ends unsubscribed', async () => {
  let hold = false;
  const m = modeled(() => (hold ? 'hold' : 'ok'));
  await m.show(['a', 'b'], 1);
  await settled();
  hold = true;
  await m.show([], 2);
  await m.show(['a', 'b'], 3);
  hold = false;
  for (const entry of [...m.held]) entry.settle();
  await settled();
  assertConverged(m, ['a', 'b'], 'hide then show');

  hold = true;
  await m.show(['a', 'b', 'c'], 4);
  assert.ok(m.take('thread/resume', 'c'));
  await m.show(['a', 'b'], 5);
  hold = false;
  m.take('thread/resume', 'c').settle();
  await settled();
  assertConverged(m, ['a', 'b'], 'show then hide');
  assert.equal(m.timers.size, 0);
});

test('a registration is accepted at once and never waits on any thread: a held request holds back no other thread', async () => {
  const m = modeled((method, threadId) => (threadId === 'a' ? 'hold' : 'ok'));
  let accepted = false;
  void m.show(['a', 'b'], 1).then(() => (accepted = true));
  await tick();
  assert.equal(accepted, true, 'accepted while a is still unanswered');
  await settled();
  assert.deepEqual([...m.current().core], ['b'], 'b subscribed while a is held');
  assert.equal(await m.show(['a', 'b', 'c'], 2), true);
  await settled();
  assert.deepEqual([...m.current().core].sort(), ['b', 'c']);
  assert.equal(m.sent.filter(([, method, threadId]) => method === 'thread/resume' && threadId === 'a').length, 1, 'a has one request at a time');
});

test('a session the core does not have is retried at the slowest rate and does not stop the others; the answer stays true', async () => {
  let gone = true;
  const m = modeled((method, threadId) => (gone && threadId === 'a' ? 'unavailable' : 'ok'));
  assert.equal(await m.show(['a', 'b', 'c'], 1), true);
  await settled();
  assertConverged(m, ['b', 'c']);
  assert.deepEqual([...m.timers].map((timer) => timer.ms), [FOLLOW_RETRY_MAX_MS]);
  gone = false;
  m.fire();
  await settled();
  assertConverged(m, ['a', 'b', 'c'], 'followed once the core has it');
});

test('a failing thread is retried with a doubling delay up to the cap, without end', async () => {
  let failing = true;
  const m = modeled(() => (failing ? 'fail' : 'ok'));
  await m.show(['a'], 1);
  await settled();
  const delays = [];
  for (let i = 0; i < 9; i++) {
    assert.equal(m.timers.size, 1, 'one timer per thread');
    delays.push(...m.fire());
    await settled();
  }
  const doubled = Array.from({ length: 9 }, (_, i) => Math.min(FOLLOW_RETRY_MAX_MS, FOLLOW_RETRY_MS * 2 ** i));
  assert.deepEqual(delays, doubled);
  assert.equal(delays.at(-1), FOLLOW_RETRY_MAX_MS, 'capped, and still retrying');
  failing = false;
  m.fire();
  await settled();
  assertConverged(m, ['a']);
  assert.equal(m.timers.size, 0);
});

test('a replacement resume that fails is repaired by the lane itself, with no further registration', async () => {
  let refuse = false;
  const m = modeled((method) => (refuse && method === 'thread/resume' ? 'fail' : 'ok'));
  await m.show(['a', 'b'], 1);
  await settled();
  refuse = true;
  m.replace();
  await settled();
  assertConverged(m, [], 'the new client follows nothing yet');
  assert.equal(m.timers.size, 2);
  refuse = false;
  m.fire();
  await settled();
  assertConverged(m, ['a', 'b'], 'repaired on the new client');
});

test('a late answer of a retired generation changes nothing, whether it succeeds or fails', async () => {
  let hold = false;
  const m = modeled(() => (hold ? 'hold' : 'ok'));
  hold = true;
  await m.show(['a', 'b'], 1);
  const oldA = m.take('thread/resume', 'a');
  const oldB = m.take('thread/resume', 'b');
  hold = false;
  m.replace();
  await settled();
  assertConverged(m, ['a', 'b'], 'the new generation does not wait for the old requests');
  await m.show(['a'], 2);
  await settled();
  assertConverged(m, ['a']);
  const before = m.sent.length;
  // The old client's answers land on a closed client: as if it had answered just before closing.
  oldA.client.closed = false;
  oldA.settle('ok');
  oldB.settle('fail');
  await settled();
  assert.equal(m.sent.length, before, 'no request follows a stale answer');
  assert.equal(m.timers.size, 0, 'a stale failure schedules no retry');
  assertConverged(m, ['a']);
});

test('a retired attempt that is answered while the next one is in flight starts nothing', async () => {
  const m = modeled((method, threadId, client) => (client.id === 1 && method === 'thread/unsubscribe') || client.id === 2 ? 'hold' : 'ok');
  await m.show(['a'], 1);
  await settled();
  await m.show([], 2);
  const oldHide = m.take('thread/unsubscribe', 'a');
  await m.show(['a'], 3);
  m.replace();
  await tick();
  const resume = m.take('thread/resume', 'a');
  assert.equal(resume.client.id, 2);
  oldHide.settle('fail');
  await settled();
  assert.equal(m.held.length, 1, 'the retired attempt did not free the thread for a second request');
  assert.equal(m.timers.size, 0);
  resume.settle();
  await settled();
  assertConverged(m, ['a']);
});

test('the rejected interleaving: an owed cleanup survives the replacement it follows, and a later hide really unsubscribes', async () => {
  let hideFails = false;
  const m = modeled((method, threadId, client) => {
    if (method !== 'thread/unsubscribe') return 'ok';
    if (client.id === 1) return 'hold';
    return hideFails ? 'fail' : 'ok';
  });
  await m.show(['a'], 1);
  await settled();
  // The old unsubscribe is pending, a show waits behind it, then the client is replaced.
  await m.show([], 2);
  const oldHide = m.take('thread/unsubscribe', 'a');
  await m.show(['a'], 3);
  m.replace();
  oldHide.settle('fail');
  await settled();
  assertConverged(m, ['a'], 'the show resumed on the new connection');
  // The hide's unsubscribe fails on the new connection: the core may still feed it.
  hideFails = true;
  await m.show([], 4);
  await settled();
  assert.deepEqual([...m.current().core], ['a'], 'still fed');
  assert.deepEqual([...m.current().subs], [], 'not followed locally');
  assert.equal(m.timers.size, 1, 'the cleanup is owed');
  hideFails = false;
  const unsubscribes = m.sent.filter(([, method]) => method === 'thread/unsubscribe').length;
  // A later hide of the same thread is the same need: the owed cleanup keeps its backoff deadline, and is sent at it.
  await m.show([], 5);
  await settled();
  assert.equal(m.sent.filter(([, method]) => method === 'thread/unsubscribe').length, unsubscribes);
  assert.equal(m.timers.size, 1);
  m.fire();
  await settled();
  assert.equal(m.sent.filter(([, method]) => method === 'thread/unsubscribe').length, unsubscribes + 1, 'the cleanup is sent');
  assertConverged(m, []);
  assert.equal(m.timers.size, 0);
});

test('an owed cleanup is retried by its timer alone', async () => {
  let hideFails = true;
  const m = modeled((method) => (hideFails && method === 'thread/unsubscribe' ? 'fail' : 'ok'));
  await m.show(['a'], 1);
  await settled();
  await m.show([], 2);
  await settled();
  assert.deepEqual([...m.current().core], ['a']);
  hideFails = false;
  m.fire();
  await settled();
  assertConverged(m, []);
});

test('an owed cleanup ends with the connection it was owed on', async () => {
  const m = modeled((method) => (method === 'thread/unsubscribe' ? 'fail' : 'ok'));
  await m.show(['a'], 1);
  await settled();
  await m.show([], 2);
  await settled();
  assert.equal(m.timers.size, 1);
  const before = m.sent.length;
  m.reconnect();
  await settled();
  assertConverged(m, [], 'the new connection was never subscribed');
  assert.equal(m.sent.length, before, 'nothing is owed to it');
  assert.equal(m.timers.size, 0);
});

test('a request lost with the client\'s own connection is sent again on the new one at once, not after a backoff', async () => {
  let hold = true;
  const m = modeled(() => (hold ? 'hold' : 'ok'));
  await m.show(['a', 'b'], 1);
  m.reconnect();
  hold = false;
  for (const entry of [...m.held]) entry.settle();
  await settled();
  assertConverged(m, ['a', 'b']);
  assert.equal(m.timers.size, 0);
  hold = true;
  await m.show(['a'], 2);
  m.reconnect();
  hold = false;
  for (const entry of [...m.held]) entry.settle();
  await settled();
  assertConverged(m, ['a'], 'the ended connection took b with it');
  assert.equal(m.timers.size, 0, 'nothing is owed or retried');
});

test('a thread another caller follows is left alone: never registered, or resumed again after the lane let it go', async () => {
  const m = modeled();
  // A new thread's snapshot: followed by its caller before any registration can name it.
  await m.current().resumeThread('n', { lastItems: 32 });
  await m.show(['a'], 1);
  await settled();
  await m.show([], 2);
  await settled();
  // The lane let `a` go; another caller follows it again.
  await m.current().resumeThread('a', { lastItems: 32 });
  await m.show(['b'], 3);
  m.reconnect();
  for (const entry of [...m.held]) entry.settle();
  await settled();
  m.fire();
  await settled();
  assert.equal(m.sent.filter(([, method, threadId]) => method === 'thread/unsubscribe' && threadId !== 'a').length, 0);
  assert.equal(m.sent.filter(([, method, threadId]) => method === 'thread/unsubscribe' && threadId === 'a').length, 1, 'only the lane\'s own hide');
  assertConverged(m, ['a', 'b', 'n']);
  // Shown and hidden, a thread is the lane's: hiding it unsubscribes it.
  await m.show(['b', 'n'], 4);
  await settled();
  await m.show(['b'], 5);
  await settled();
  assertConverged(m, ['a', 'b']);
});

test('a hide during the client\'s own restore waits for it, then unsubscribes what the restore attached', async () => {
  let holdRestore = false;
  const m = modeled((method) => (holdRestore && method === 'restore' ? 'hold' : 'ok'));
  await m.show(['a'], 1);
  await settled();
  holdRestore = true;
  m.reconnect();
  await m.show([], 2);
  await settled();
  assert.equal(m.sent.filter(([, method]) => method === 'thread/unsubscribe').length, 0, 'nothing is sent while the restore decides');
  m.take('restore', 'a').settle();
  await settled();
  assertConverged(m, [], 'the restored subscription is removed');
  assert.equal(m.timers.size, 0);
});

test('an unsubscribe that reaches the client after its restore began is not taken as absence', async () => {
  let holdRestore = false;
  const m = modeled((method) => (holdRestore && method === 'restore' ? 'hold' : 'ok'), { defer: true });
  await m.show(['a'], 1);
  await settled();
  holdRestore = true;
  // The hide's unsubscribe is on its way when the client reconnects and starts restoring the thread; the core answers the
  // unsubscribe at once, before the queued restore attaches the thread.
  const hide = m.show([], 2);
  m.reconnect();
  await hide;
  await settled();
  assert.equal(m.sent.filter(([, method]) => method === 'thread/unsubscribe').length, 1);
  m.take('restore', 'a').settle();
  await settled();
  assert.equal(m.sent.filter(([, method]) => method === 'thread/unsubscribe').length, 2, 'sent again once the restore ended');
  assertConverged(m, []);
  assert.equal(m.timers.size, 0);
});

test('a wanted thread whose restore is in flight is not resumed twice; one the restore loses is resumed by the lane', async () => {
  let restore = 'ok';
  const m = modeled((method) => (method === 'restore' ? restore : 'ok'));
  await m.show(['a', 'b'], 1);
  await settled();
  restore = 'hold';
  m.reconnect();
  await m.show(['a', 'b'], 2);
  await settled();
  const resumes = () => m.sent.filter(([, method]) => method === 'thread/resume').length;
  assert.equal(resumes(), 2, 'the restores are the client\'s');
  m.take('restore', 'a').settle();
  m.take('restore', 'b').settle('fail');
  await settled();
  assert.equal(resumes(), 3, 'the lost one is resumed');
  assertConverged(m, ['a', 'b']);
});

test('a wake during a request that then fails is acted on at once, not after the backoff', async () => {
  const m = modeled((method) => (method === 'thread/resume' ? 'hold' : 'ok'));
  await m.show(['a'], 1);
  await m.show([], 2);
  m.take('thread/resume', 'a').settle('fail');
  await settled();
  assert.equal(m.timers.size, 0, 'the hide was read when the resume failed: nothing is retried');
  assertConverged(m, []);
});

test('wakes for an unchanged need keep the backoff; a changed need or a new generation acts at once', async () => {
  let hold = true;
  const m = modeled((method) => (method !== 'thread/resume' ? 'ok' : hold ? 'hold' : 'fail'));
  const resumes = () => m.sent.filter(([, method]) => method === 'thread/resume').length;
  await m.show(['a'], 1);
  // Unchanged registrations while the resume is in flight, then it fails: one retry, at its deadline.
  await m.show(['a'], 2);
  await m.show(['a'], 3);
  await m.show(['a'], 4);
  hold = false;
  m.take('thread/resume', 'a').settle('fail');
  await settled();
  assert.equal(resumes(), 1);
  assert.equal(m.timers.size, 1);
  // Unchanged registrations while the retry waits: nothing is sent and the deadline stands.
  const [deadline] = [...m.timers];
  for (let version = 5; version < 25; version++) await m.show(['a'], version);
  await settled();
  assert.equal(resumes(), 1);
  assert.deepEqual([...m.timers], [deadline]);
  m.fire();
  await settled();
  assert.equal(resumes(), 2, 'the deadline sends it');
  assert.equal(m.timers.size, 1);
  // A new generation acts at once.
  m.replace();
  await settled();
  assert.equal(resumes(), 3);
  // So does a changed need: hidden while waiting, it is let go without waiting for the deadline.
  await m.show([], 25);
  await settled();
  assert.equal(m.timers.size, 0);
  assertConverged(m, []);
});

test('a thread that keeps failing leaves a report at the third failure and every twentieth after', async () => {
  const lines = [];
  const m = modeled((method) => (method === 'thread/resume' ? 'fail' : 'ok'), { report: (line) => lines.push(line) });
  await m.show(['abcdefgh-0123'], 1);
  await settled();
  for (let i = 0; i < 25; i++) {
    m.fire();
    await settled();
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[mixdog-lane\] follow failing thread=fgh-0123 resume failures=3 retryMs=2000 error=bad$/);
  assert.match(lines[1], /failures=23 retryMs=30000/);
  assert.equal(m.timers.size, 1, 'and keeps retrying');
});

test('the main process client disposes its service lane: an outstanding retry sends nothing more', async () => {
  const m = modeled((method) => (method === 'thread/resume' ? 'fail' : 'ok'));
  const client = new DesktopServiceClient({ serviceLane: m.service, sessionLane: { dispose() {} } });
  await client.setVisibleSessions(['a']);
  await settled();
  assert.equal(m.timers.size, 1);
  const before = m.sent.length;
  await client.dispose();
  assert.equal(m.timers.size, 0, 'the retry is cancelled');
  assert.equal(m.listeners(), 0, 'and the lane listens to nothing');
  m.reconnect();
  await settled();
  assert.equal(m.sent.length, before);
});

test('repeated replacements leave one retry per thread and no stranded work; dispose releases it all', async () => {
  let refuse = true;
  const m = modeled((method, threadId, client) => (client.id > 1 && refuse ? (threadId === 'a' ? 'hold' : 'fail') : 'ok'));
  await m.show(['a', 'b'], 1);
  await settled();
  for (let i = 0; i < 25; i++) {
    m.replace();
    await settled();
    assert.ok(m.timers.size <= 1, 'at most b retries');
    assert.equal(m.held.filter((entry) => entry.client === m.current()).length, 1, 'one request of a on the open client');
  }
  refuse = false;
  m.replace();
  m.fire();
  await settled();
  assertConverged(m, ['a', 'b']);
  assert.equal(m.timers.size, 0);
  await m.show(['a', 'b', 'c'], 2);
  refuse = true;
  m.replace();
  await settled();
  assert.ok(m.timers.size > 0);
  const before = m.sent.length;
  m.service.dispose();
  assert.equal(m.timers.size, 0, 'dispose cancels the retries');
  assert.equal(m.listeners(), 0, 'and removes its listeners');
  for (const entry of [...m.held]) entry.settle('fail');
  await m.show(['d'], 3);
  await settled();
  assert.equal(m.sent.length, before, 'nothing starts after dispose');
});

// ── the real client over its mock transport ──

/** A client of the library connected over `net`, whose core is `serve(request, conn)` for every request it sends. */
async function realClient(net, serve) {
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await accepted(net, serve);
  return { client: await connecting, conn };
}
/** The next connection a client opens over `net`: its handshake answered, then every request served. */
async function accepted(net, serve) {
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  void (async () => {
    for (;;) serve(JSON.parse(await conn.nextSent()), conn);
  })();
  return conn;
}

const threadRow = (id) => ({ id, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });
/** A core that answers each `thread/resume` with a subscription and its snapshot, and records what its connection holds. A
 *  resume held (`resume` answers 'hold') is answered by `release`, and attaches the thread only then, as the core's queued
 *  resume does; `thread/unsubscribe` is answered at once. `other` answers any other request. */
function scriptedCore({ resume = () => 'ok', unsubscribe = () => 'ok', other = () => ({}) } = {}) {
  let epochs = 0;
  const subscribed = new Set();
  const epochOf = new Map();
  const held = [];
  const answerResume = (request, conn, attach = true) => {
    const threadId = request.params.threadId;
    const epoch = `e${++epochs}`;
      epochOf.set(threadId, epoch);
      if (attach) subscribed.add(threadId);
      conn.serverSend({ id: request.id, result: { thread: threadRow(threadId), subscription: { id: `s${epochs}`, mode: 'snapshot', epoch, startSeq: 1 } } });
      conn.serverSend({
        method: 'thread/snapshot',
        params: { thread: threadRow(threadId), items: [], state: { title: 'T' }, hasOlder: false },
        feed: { id: threadId, epoch, seq: 1 },
      });
  };
  const serve = (request, conn) => {
    const threadId = request.params?.threadId;
    if (request.method === 'thread/resume') {
      const outcome = resume(threadId);
      if (outcome === 'hold') return void held.push({ request, conn });
      if (outcome === 'fail') return conn.serverSend({ id: request.id, error: { code: -32603, message: 'bad' } });
      answerResume(request, conn);
    } else if (request.method === 'thread/unsubscribe') {
      const outcome = unsubscribe(threadId);
      if (outcome === 'hold') return void held.push({ request, conn });
      if (outcome === 'fail') return conn.serverSend({ id: request.id, error: { code: -32603, message: 'bad' } });
      subscribed.delete(threadId);
      conn.serverSend({ id: request.id, result: {} });
    } else conn.serverSend({ id: request.id, result: other(request) });
  };
  const takeHeld = (method, threadId) => {
    const at = held.findIndex(({ request }) => request.method === method && request.params.threadId === threadId);
    return held.splice(at, 1)[0];
  };
  return {
    serve,
    subscribed,
    /** Answers the held resume of `threadId`. */
    release(threadId) {
      const { request, conn } = takeHeld('thread/resume', threadId);
      answerResume(request, conn);
    },
    /** The held resume of `threadId`: `attach` registers the subscription now (the core processes it), `reply` sends its
     *  answer and snapshot. */
    heldResume(threadId) {
      const { request, conn } = takeHeld('thread/resume', threadId);
      return { attach: () => subscribed.add(threadId), reply: () => answerResume(request, conn, false) };
    },
    /** The held unsubscribe of `threadId`: `remove` takes the thread off the connection now (the core processes it), `reply`
     *  sends its answer; the two may be apart, with other answers between them. */
    heldUnsubscribe(threadId) {
      const { request, conn } = takeHeld('thread/unsubscribe', threadId);
      return {
        remove: () => subscribed.delete(threadId),
        reply: () => conn.serverSend({ id: request.id, result: {} }),
      };
    },
    /** A live frame of the thread's feed, as the core sends it to a subscribed connection. */
    frame(conn, threadId, title, seq = 2) {
      conn.serverSend({ method: 'thread/name/updated', params: { threadId, title }, feed: { id: threadId, epoch: epochOf.get(threadId), seq } });
    },
  };
}

/** The desktop connection's part the lane reads, over a real client that can be replaced. `handOver` delays an unsubscribe
 *  on its way to the client, as the renderer's connection does. */
function replaceable(first, { handOver = async () => undefined } = {}) {
  let client = first;
  const replaced = new Set();
  const events = new Set();
  const stores = new Set();
  let unbind = () => undefined;
  const bind = () => {
    const offEvents = client.on((event) => events.forEach((listener) => listener(event)));
    const offStore = client.store.subscribe((change) => stores.forEach((listener) => listener(change)));
    unbind = () => (offEvents(), offStore());
  };
  bind();
  return {
    protocol: {
      call: (method, params) => client.call(method, params),
      notify: () => undefined,
      client: () => client,
      resumeThread: (threadId, window) => client.resumeThread(threadId, window),
      unsubscribeThread: async (threadId) => {
        await handOver();
        return client.unsubscribeThread(threadId);
      },
      onEvent: (listener) => (events.add(listener), () => events.delete(listener)),
      onReplaced: (listener) => (replaced.add(listener), () => replaced.delete(listener)),
      onStoreChange: (listener) => (stores.add(listener), () => stores.delete(listener)),
    },
    async replace(next) {
      unbind();
      const old = client;
      client = next;
      bind();
      await old.close();
      replaced.forEach((listener) => listener());
    },
  };
}
const titleOf = (client, threadId) => client.store.thread(threadId)?.state.fields.desktopSessionTitle;

test('real client: a held resume of one thread holds back neither the registration nor another thread\'s live frames', async () => {
  const net = new MockNetwork();
  const core = scriptedCore({ resume: (threadId) => (threadId === 'a' ? 'hold' : 'ok') });
  const { client, conn } = await realClient(net, core.serve);
  const service = createServiceLane({ protocol: replaceable(client).protocol, snapshot: () => HELD, schedule: () => () => undefined });
  assert.equal(await service.call('setVisibleSessions', [['a', 'b'], 1]), true);
  await settled();
  assert.equal(client.threadSubscription('b').followed, true);
  assert.equal(client.threadSubscription('a').followed, false);
  core.frame(conn, 'b', 'live');
  await settled();
  assert.equal(titleOf(client, 'b'), 'live', 'b\'s live frame is folded');
  service.dispose();
  await client.close();
});

test('real client: a failed unsubscribe is owed until it succeeds; showing again resumes, and live frames are folded again', async () => {
  const net = new MockNetwork();
  let failUnsubscribe = true;
  const core = scriptedCore({ unsubscribe: () => (failUnsubscribe ? 'fail' : 'ok') });
  const { client, conn } = await realClient(net, core.serve);
  const timers = [];
  const service = createServiceLane({
    protocol: replaceable(client).protocol,
    snapshot: () => HELD,
    schedule: (run) => (timers.push(run), () => timers.splice(timers.indexOf(run), 1)),
  });
  await service.call('setVisibleSessions', [['a'], 1]);
  await settled();
  assert.equal(await service.call('setVisibleSessions', [[], 2]), true);
  await settled();
  assert.equal(client.store.thread('a'), undefined, 'the real client drops its fold before the request is answered');
  assert.deepEqual([...core.subscribed], ['a'], 'the core still feeds it');
  assert.equal(timers.length, 1, 'the cleanup is owed');
  await service.call('setVisibleSessions', [['a'], 3]);
  await settled();
  assert.equal(timers.length, 0, 'showing it again settles the debt');
  core.frame(conn, 'a', 'live');
  await settled();
  assert.equal(titleOf(client, 'a'), 'live', 'live frames are folded again');
  failUnsubscribe = false;
  await service.call('setVisibleSessions', [[], 4]);
  await settled();
  assert.deepEqual([...core.subscribed], []);
  assert.equal(client.store.thread('a'), undefined);
  service.dispose();
  await client.close();
});

test('real client: after a replacement whose resume fails, the lane repairs it alone and live frames reach the new client', async () => {
  const net = new MockNetwork();
  const first = scriptedCore();
  const { client } = await realClient(net, first.serve);
  const link = replaceable(client);
  const timers = [];
  const service = createServiceLane({
    protocol: link.protocol,
    snapshot: () => HELD,
    schedule: (run) => (timers.push(run), () => timers.splice(timers.indexOf(run), 1)),
  });
  await service.call('setVisibleSessions', [['a'], 1]);
  await settled();
  let refuse = true;
  const second = scriptedCore({ resume: () => (refuse ? 'fail' : 'ok') });
  const reopened = await realClient(net, second.serve);
  await link.replace(reopened.client);
  await settled();
  assert.equal(reopened.client.threadSubscription('a').followed, false, 'the replacement resume was refused');
  assert.equal(timers.length, 1);
  refuse = false;
  timers.shift()();
  await settled();
  assert.equal(reopened.client.threadSubscription('a').followed, true);
  assert.deepEqual([...second.subscribed], ['a']);
  second.frame(reopened.conn, 'a', 'after repair');
  await settled();
  assert.equal(titleOf(reopened.client, 'a'), 'after repair');
  service.dispose();
  await reopened.client.close();
});

test('real client: a forked thread\'s snapshot is not torn down by the lane, and the fork answers its state', async () => {
  const net = new MockNetwork();
  const core = scriptedCore({ other: (request) => (request.method === 'thread/fork' ? { thread: threadRow('forked') } : {}) });
  const { client } = await realClient(net, core.serve);
  const service = createServiceLane({ protocol: replaceable(client).protocol, snapshot: () => HELD, schedule: () => () => undefined });
  await service.call('setVisibleSessions', [['src'], 1]);
  await settled();
  const answer = await createChatApi(client, sharedFor(client)).inheritSession('src', null, null);
  assert.equal(answer.sessionId, 'forked');
  assert.ok(answer.snapshot, 'the fork answers the new thread\'s state');
  await settled();
  assert.equal(client.threadSubscription('forked').followed, true, 'its caller\'s subscription stays');
  assert.deepEqual([...core.subscribed].sort(), ['forked', 'src']);
  // Shown, then hidden, it is the lane's to let go.
  await service.call('setVisibleSessions', [['src', 'forked'], 2]);
  await settled();
  await service.call('setVisibleSessions', [['src'], 3]);
  await settled();
  assert.deepEqual([...core.subscribed], ['src']);
  service.dispose();
  await client.close();
});

test('real client: a hide while the client restores the thread after its own reconnect ends unsubscribed at the core', async () => {
  const net = new MockNetwork();
  let holdResume = false;
  const core = scriptedCore({ resume: () => (holdResume ? 'hold' : 'ok') });
  const { client, conn } = await realClient(net, core.serve);
  const service = createServiceLane({ protocol: replaceable(client).protocol, snapshot: () => HELD, schedule: () => () => undefined });
  await service.call('setVisibleSessions', [['a'], 1]);
  await settled();
  holdResume = true;
  // The connection ends: the core drops what it held, the client reconnects and restores `a`, held at the core.
  conn.serverClose(1001, 'gone');
  core.subscribed.clear();
  await accepted(net, core.serve);
  await settled();
  assert.equal(client.threadSubscription('a').restoring, true);
  await service.call('setVisibleSessions', [[], 2]);
  await settled();
  core.release('a');
  await settled();
  assert.equal(client.threadSubscription('a').restoring, false);
  assert.deepEqual([...core.subscribed], [], 'what the restore attached is unsubscribed');
  assert.equal(client.threadSubscription('a').followed, false);
  service.dispose();
  await client.close();
});

/** A real client following `a` through the lane, whose hide's unsubscribe reaches the client only after the client has
 *  reconnected and started restoring `a`. Both the restore and the unsubscribe are then held at the core, for the test to
 *  answer in the order it chooses. */
async function overlappedHide() {
  const net = new MockNetwork();
  let hold = false;
  const core = scriptedCore({ resume: () => (hold ? 'hold' : 'ok'), unsubscribe: () => (hold ? 'hold' : 'ok') });
  const { client, conn } = await realClient(net, core.serve);
  let open;
  let gate = Promise.resolve();
  const unsubscribes = () => sent.filter((method) => method === 'thread/unsubscribe').length;
  const sent = [];
  const link = replaceable(client, { handOver: () => gate });
  const send = client.unsubscribeThread.bind(client);
  client.unsubscribeThread = (threadId) => (sent.push('thread/unsubscribe'), send(threadId));
  const service = createServiceLane({ protocol: link.protocol, snapshot: () => HELD, schedule: () => () => undefined });
  await service.call('setVisibleSessions', [['a'], 1]);
  await settled();
  hold = true;
  gate = new Promise((resolve) => (open = resolve));
  await service.call('setVisibleSessions', [[], 2]);
  await settled();
  conn.serverClose(1001, 'gone');
  core.subscribed.clear();
  await accepted(net, core.serve);
  await settled();
  assert.equal(client.threadSubscription('a').restoring, true, 'the restore is in flight');
  open();
  await settled();
  assert.equal(unsubscribes(), 1);
  hold = false;
  const unsubscribe = core.heldUnsubscribe('a');
  const restore = core.heldResume('a');
  return { core, client, service, unsubscribe, restore, unsubscribes };
}
const endsUnsubscribed = async ({ core, client, service, unsubscribes }) => {
  await settled();
  assert.equal(unsubscribes(), 2, 'the overlapped unsubscribe is sent again');
  assert.deepEqual([...core.subscribed], [], 'the core feeds nothing');
  assert.equal(client.threadSubscription('a').followed, false);
  service.dispose();
  await client.close();
};

test('real client: the core removes the thread, then attaches the restore; both answers arrive in one turn', async () => {
  const run = await overlappedHide();
  run.unsubscribe.remove();
  run.restore.attach();
  run.unsubscribe.reply();
  run.restore.reply();
  assert.deepEqual([...run.core.subscribed], ['a']);
  await endsUnsubscribed(run);
});

test('real client: the restore is answered and settles while the lane\'s unsubscribe is still in flight', async () => {
  const run = await overlappedHide();
  run.unsubscribe.remove();
  run.restore.attach();
  run.restore.reply();
  await settled();
  assert.equal(run.client.threadSubscription('a').restoring, false, 'the restore ended before the unsubscribe was answered');
  assert.equal(run.unsubscribes(), 1, 'the lane still waits on its request');
  run.unsubscribe.reply();
  await endsUnsubscribed(run);
});

test('real client: answers in the reverse of processing order, either way round', async () => {
  // Processed: unsubscribe, then the restore attaches. Answered: the restore first.
  const first = await overlappedHide();
  first.unsubscribe.remove();
  first.restore.attach();
  first.restore.reply();
  await tick();
  first.unsubscribe.reply();
  assert.deepEqual([...first.core.subscribed], ['a']);
  await endsUnsubscribed(first);
  // Processed: the restore attaches, then the unsubscribe removes it. Answered: the unsubscribe first.
  const second = await overlappedHide();
  second.restore.attach();
  second.unsubscribe.remove();
  second.unsubscribe.reply();
  await tick();
  second.restore.reply();
  assert.deepEqual([...second.core.subscribed], []);
  await endsUnsubscribed(second);
});

test('real client: threads restored and then hidden leave nothing behind in the client', async () => {
  const net = new MockNetwork();
  const core = scriptedCore();
  const { client, conn } = await realClient(net, core.serve);
  const service = createServiceLane({ protocol: replaceable(client).protocol, snapshot: () => HELD, schedule: () => () => undefined });
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
  await service.call('setVisibleSessions', [ids, 1]);
  await settled();
  conn.serverClose(1001, 'gone');
  core.subscribed.clear();
  await accepted(net, core.serve);
  await settled();
  assert.deepEqual([...core.subscribed].sort(), [...ids].sort(), 'restored');
  await service.call('setVisibleSessions', [[], 2]);
  await settled();
  assert.deepEqual([...core.subscribed], []);
  // No map or set of the client is keyed by a thread it no longer follows, but the feed-event counts of its send claims,
  // which predate this lane and are kept for the client's life.
  const kept = [];
  for (const [field, value] of Object.entries(client)) {
    if (!(value instanceof Map || value instanceof Set) || field === 'threadLastEvent') continue;
    for (const key of value.keys()) if (ids.includes(key)) kept.push(`${field}:${key}`);
  }
  assert.deepEqual(kept, []);
  service.dispose();
  await client.close();
});

test('searchProjectFiles starts a consumer once per root and only re-queries after', async () => {
  const { calls, service } = lane();
  await service.call('searchProjectFiles', ['/p', 'a', 50, false, false, 'mention']);
  await service.call('searchProjectFiles', ['/p', 'ab', 50, false, false, 'mention']);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['search/start', 'search/update', 'search/update']
  );
});

// The core answers `search/update` with nothing: the files come on the search's feed (`search/updated`), and `search/completed`
// ends the query. Node's method answered the paths, a folder's ending with a slash.
test('searchProjectFiles answers the files the feed carried for its query when the core completes it', async () => {
  let emitFor;
  const { service, emit } = lane(async (method, params) => {
    if (method === 'search/update') emitFor(params);
    return {};
  });
  emitFor = ({ sessionId, query }) => {
    emit('search/updated', { sessionId, query: 'other', files: [{ path: 'stale.ts', matchType: 'file' }] });
    emit('search/updated', { sessionId: 'search:another', query, files: [{ path: 'theirs.ts', matchType: 'file' }] });
    emit('search/updated', { sessionId, query, files: [{ path: 'src', matchType: 'directory' }, { path: 'src/a.ts', matchType: 'file' }] });
  };
  assert.deepEqual(await service.call('searchProjectFiles', ['/p', 'a', 50, false, true, 'mention']), ['src/', 'src/a.ts']);
});

test('a newer query of the same consumer ends the older one, which answers what it had', async () => {
  const held = [];
  const listeners = new Set();
  const emit = (method, params) => {
    for (const listener of [...listeners]) listener({ type: 'notification', notification: { method, params } });
  };
  const call = async (method, params) => {
    if (method === 'search/update') held.push(params.query);
    return {};
  };
  const service = createServiceLane({
    protocol: { call, ...threadCalls(call), notify: () => undefined, onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)) },
    snapshot: () => HELD,
  });
  const older = service.call('searchProjectFiles', ['/p', 'a', 50, false, false, 'mention']);
  await new Promise((resolve) => setImmediate(resolve));
  emit('search/updated', { sessionId: 'search:mention', query: 'a', files: [{ path: 'a.ts', matchType: 'file' }] });
  const newer = service.call('searchProjectFiles', ['/p', 'ab', 50, false, false, 'mention']);
  assert.deepEqual(await older, ['a.ts'], 'the core completes only the query it holds');
  await new Promise((resolve) => setImmediate(resolve));
  emit('search/updated', { sessionId: 'search:mention', query: 'ab', files: [{ path: 'ab.ts', matchType: 'file' }] });
  emit('search/completed', { sessionId: 'search:mention', query: 'ab' });
  assert.deepEqual(await newer, ['ab.ts']);
  assert.deepEqual(held, ['a', 'ab']);
  // The lane's own listener (connection readiness, lost subscriptions) lasts until it is disposed.
  assert.equal(listeners.size, 1, 'no search listener outlives its query');
  service.dispose();
  assert.equal(listeners.size, 0);
});

// Recorded from a core on a converted profile (2026-11-13): `project/list` answers `{ projects: [{ path, name, alias, hidden,
// lastUsedAt }] }`, and the project folders `{ path }`. The contract's answers are the rows and the strings.
test('the project list is the contract rows, and a project folder is its path', async () => {
  const { service } = lane(async (method) =>
    method === 'project/list'
      ? { projects: [{ path: 'C:\\Project\\mixdog', name: 'mixdog', alias: null, hidden: false, lastUsedAt: 1794176253087 }] }
      : { path: 'C:\\answered' }
  );
  assert.deepEqual(await service.call('listProjects', []), [{ name: 'mixdog', path: 'C:\\Project\\mixdog', alias: null }]);
  for (const [method, args] of [
    ['projectDirectory', ['/p']],
    ['projectRecoveryDirectory', ['/p']],
    ['getTaskWorkspace', []],
    ['projectEntryPath', ['/p', 'a']],
  ]) {
    assert.equal(await service.call(method, args), 'C:\\answered', method);
  }
});

test('an attachment is read a page at a time by its digest; a missing one, one over the bound and a non-reference are null', async () => {
  const ref = 'a'.repeat(64);
  const pageBytes = 786_432;
  const blob = Buffer.alloc(pageBytes + 5, 7);
  const reads = [];
  const { service } = lane(async (method, params) => {
    assert.equal(method, 'blob/read');
    reads.push(params);
    if (params.digest !== `sha256:${ref}`) throw Object.assign(new Error('rpc'), { detail: { kind: 'rpc', data: { reason: 'blobNotFound' } } });
    return { bytesB64: blob.subarray(params.offset, params.offset + params.length).toString('base64') };
  });
  assert.equal(await service.call('readAttachmentImage', [ref]), blob.toString('base64'));
  assert.deepEqual(reads, [
    { digest: `sha256:${ref}`, offset: 0, length: pageBytes },
    { digest: `sha256:${ref}`, offset: pageBytes, length: pageBytes },
  ]);
  assert.equal(await service.call('readAttachmentImage', [ref, pageBytes + 5]), blob.toString('base64'), 'a blob of exactly the bound');
  assert.equal(await service.call('readAttachmentImage', [ref, pageBytes + 4]), null, 'one byte over the bound');
  assert.equal(await service.call('readAttachmentImage', ['b'.repeat(64)]), null, 'the store has no such blob');
  reads.length = 0;
  assert.equal(await service.call('readAttachmentImage', ['not-a-ref']), null);
  assert.deepEqual(reads, [], 'a name that is no reference is not asked for');
});

test('a method with no request op is refused before anything is sent, with no fallback', async () => {
  const { calls, service } = lane();
  for (const method of SERVICE_NOT_ROUTED) {
    await assert.rejects(service.call(method, []), (error) => error.code === 'unknownMethod', method);
  }
  await assert.rejects(service.call('agentRoomAction', ['purge', ['r1']]), (error) => error.code === 'unknownMethod');
  assert.deepEqual(calls, []);
});

// Node's perfLog wrote the renderer's diagnostic line in the host; the spec map (`operations_map.json`, list `services`)
// sends it to the core as the `client/perfLog` notification, which has no reply and no request.
test('perfLog is the client/perfLog notification with the line, and sends no request', async () => {
  const { calls, notified, service } = lane();
  assert.equal(await service.call('perfLog', ['composer-keystroke paint=30ms']), undefined);
  assert.deepEqual(notified, [{ method: 'client/perfLog', params: { line: 'composer-keystroke paint=30ms' } }]);
  assert.deepEqual(calls, []);
  const target = JSON.parse(readFileSync(new URL('operations_map.json', schemaDir), 'utf8')).inventory.find(
    (row) => row.list === 'services' && row.name === 'perfLog'
  ).target;
  assert.deepEqual(target, { kind: 'clientNotification', target: 'client/perfLog' });
});

test('an aborted request is not sent, and a domainError is mapped like the capability lane', async () => {
  const { calls, service } = lane();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.call('readSessionFinalAnswer', ['t1', 1], controller.signal));
  assert.deepEqual(calls, []);
  const failing = lane(async () => {
    throw Object.assign(new Error('rpc'), {
      detail: { kind: 'rpc', data: { reason: 'domainError', message: 'refused', code: 'X', detail: { type: 'x' } } },
    });
  });
  await assert.rejects(failing.service.call('listProjects', []), (error) => error.code === 'X');
});

test('a client calls its service lane', async () => {
  const { calls, service } = lane();
  const client = new DesktopServiceClient({ serviceLane: service });
  await client.listProjects();
  await client.markSessionRead('t1', 3);
  assert.equal(await client.getSnapshot(), null);
  await client.startTask();
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['project/list', 'thread/readState/update', 'project/taskWorkspace']
  );
});

test('invokeDesktopOperation and notifyDesktopOperation use the operation lane when the client has one', async () => {
  const seen = [];
  const client = new DesktopServiceClient({
    operationLane: {
      invoke: async (name, args) => {
        seen.push([name, args]);
        return 'done';
      },
    },
  });
  assert.equal(await client.invokeDesktopOperation('gitStatus', ['/r', true]), 'done');
  client.notifyDesktopOperation('termFocus', ['t']);
  await Promise.resolve();
  assert.deepEqual(seen, [
    ['gitStatus', ['/r', true]],
    ['termFocus', ['t']],
  ]);
});

test('a file method resolves its project through project/directory and sends only the folder it answered', async () => {
  const { calls, service } = lane();
  await service.call('readProjectTextFile', ['/project-string', 'a.txt']);
  assert.deepEqual(calls, [
    { method: 'project/directory', params: { path: '/project-string' } },
    { method: 'projectFs/readText', params: { root: '/resolved', rel: 'a.txt' } },
  ]);
  assert.ok(calls.every(({ params }) => params.root !== '/project-string'));
});

test('a project the core refuses sends no file request, and the refusal reaches the caller', async () => {
  const refused = Object.assign(new Error('Project is not available.'), { code: -32600 });
  const { calls, service } = lane(async (method) => {
    if (method === 'project/directory') throw refused;
    return { ok: true };
  });
  await assert.rejects(service.call('writeProjectTextFile', ['/nope', 'a', 'c', 'e']));
  assert.deepEqual(calls.map(({ method }) => method), ['project/directory']);
});

test('a folder answer without a path is an error, not a request with the project string', async () => {
  const { calls, service } = lane(async () => ({}));
  await assert.rejects(service.call('statProjectFile', ['/p', 'a']), /did not answer a folder/);
  assert.equal(calls.length, 1);
});

test('a client with a capability lane sends an approval decision through it, and perfLog through the service lane', async () => {
  const { calls, notified, service } = lane();
  const decided = [];
  const client = new DesktopServiceClient({
    serviceLane: service,
    capabilityLane: { resolveToolApproval: async (...args) => (decided.push(args), true) },
  });
  assert.equal(await client.resolveToolApprovalForSession('t1', 'a1', { approved: true }), true);
  assert.deepEqual(decided, [['t1', 'a1', { approved: true }]]);
  client.perfLog('x');
  await Promise.resolve();
  assert.deepEqual(notified, [{ method: 'client/perfLog', params: { line: 'x' } }]);
  assert.deepEqual(calls, []);
});
