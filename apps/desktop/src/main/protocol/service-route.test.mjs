// The DesktopService methods as core requests (service-route.ts): the exact op and params each converted method
// sends, the methods with no op (refused before anything is sent), and the client's wiring. Expected values are
// written from the Rust params (`client_methods.json`), not from the router; every param sent must be a property of
// the op's schema.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DesktopServiceClient } from '../desktop-service-client.ts';
import { SERVICE_NOT_ROUTED, createServiceLane } from './service-route.ts';

const schemaDir = new URL('../../../../../native/core/crates/mixdog-app-protocol/schema/', import.meta.url);
const clientMethods = JSON.parse(readFileSync(new URL('client_methods.json', schemaDir), 'utf8'));
const paramsSchema = (method) => clientMethods.definitions[clientMethods.methods[method].params.$ref.split('/').pop()];

const HELD = { held: true };

// A project path resolves to its folder first (project/directory); the task workspace has its own folder; everything else answers ok.
function lane(
  answer = async (method) =>
    method === 'project/directory' ? { path: '/resolved' } : method === 'project/taskWorkspace' ? { path: '/workspace' } : { ok: true }
) {
  const calls = [];
  const notified = [];
  const service = createServiceLane({
    protocol: {
      call: async (method, params) => {
        calls.push({ method, params });
        return answer(method, params);
      },
      notify: (method, params) => notified.push({ method, params }),
    },
    snapshot: () => HELD,
  });
  return { calls, notified, service };
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
  ['listSessions', [], [['thread/list', {}]]],
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
  ['readAttachmentImage', ['d1', 99], [['blob/read', { digest: 'd1', length: 99 }]]],
  ['readAttachmentImage', ['d1'], [['blob/read', { digest: 'd1' }]]],
  ['readSessionTranscript', ['t1'], [['thread/read', { threadId: 't1', window: { lastItems: 512 } }]]],
  ['readSessionHistory', ['t1'], [['thread/items/list', { threadId: 't1' }]]],
  [
    'readSessionFinalAnswer',
    ['t1', 123],
    [['thread/finalAnswer/read', { threadId: 't1', startedAt: 123 }]],
  ],
  ['prefetchSession', ['t1', 64, 'trace'], [['thread/read', { threadId: 't1', window: { lastItems: 64 } }]]],
  ['prefetchSession', ['t1'], [['thread/read', { threadId: 't1', window: { lastItems: 32 } }]]],
  [
    'readTranscriptHistory',
    ['t1', { before: 'i9', limit: 512, byteBudget: 1000 }],
    [
      [
        'thread/items/list',
        { threadId: 't1', cursor: { type: 'item', itemId: 'i9' }, limit: 512, byteBudget: 1000, sortDirection: 'desc' },
      ],
    ],
  ],
  [
    'readTranscriptHistory',
    ['t1', { after: 'i2', limit: 10 }],
    [['thread/items/list', { threadId: 't1', cursor: { type: 'item', itemId: 'i2' }, limit: 10, sortDirection: 'asc' }]],
  ],
  ['setSessionFavorite', ['t1', true], [['thread/metadata/update', { threadId: 't1', favorite: true }]]],
  ['setSessionProject', ['t1', '/p'], [['thread/metadata/update', { threadId: 't1', projectPath: '/p' }]]],
  ['setSessionArchived', ['t1', true], [['thread/archive', { threadId: 't1' }]]],
  ['setSessionArchived', ['t1', false], [['thread/unarchive', { threadId: 't1' }]]],
  ['deleteSession', ['t1'], [['thread/delete', { threadId: 't1' }]]],
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
  ['setModelRoute', [route, 't1'], [['route/set', { threadId: 't1', route }]]],
  ['setModelRoute', [route], [['route/set', { route }]]],
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
  for (const [method, args] of [['setModelRoute', [route, 't1']], ['setFast', [true]]]) {
    assert.equal(await service.call(method, args), HELD, method);
  }
  assert.deepEqual(await service.call('listProjects', []), { reply: 1 });
});

test('setVisibleSessions resumes the new visible threads and unsubscribes the ones that left', async () => {
  const { calls, service } = lane();
  await service.call('setVisibleSessions', [['a', 'b'], 1]);
  await service.call('setVisibleSessions', [['b', 'c'], 2]);
  assert.deepEqual(calls, [
    { method: 'thread/resume', params: { threadId: 'a', window: { lastItems: 32 } } },
    { method: 'thread/resume', params: { threadId: 'b', window: { lastItems: 32 } } },
    { method: 'thread/unsubscribe', params: { threadId: 'a' } },
    { method: 'thread/resume', params: { threadId: 'c', window: { lastItems: 32 } } },
  ]);
});

test('a replaced core client gets the visible threads resumed again; one it refuses is dropped and resumed by the next visible set', async () => {
  const calls = [];
  let replaced;
  let refuse = false;
  const service = createServiceLane({
    protocol: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (refuse && method === 'thread/resume' && params.threadId === 'b') throw new Error('gone');
        return { ok: true };
      },
      onReplaced: (listener) => (replaced = listener),
    },
    snapshot: () => HELD,
  });
  await service.call('setVisibleSessions', [['a', 'b'], 1]);
  calls.length = 0;
  refuse = true;
  replaced();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => [call.method, call.params.threadId]),
    [['thread/resume', 'a'], ['thread/resume', 'b']],
    'every thread the old client carried is resumed on the new one'
  );
  calls.length = 0;
  refuse = false;
  await service.call('setVisibleSessions', [['a', 'b'], 2]);
  assert.deepEqual(calls.map((call) => [call.method, call.params.threadId]), [['thread/resume', 'b']], 'the refused one is resumed by the next set; a is not sent twice');
});

test('a replacement resume refused after the thread was hidden and shown again leaves the newer state alone', async () => {
  const calls = [];
  let replaced;
  let rejectStale;
  let holdNext = false;
  const service = createServiceLane({
    protocol: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (holdNext && method === 'thread/resume') {
          holdNext = false;
          return new Promise((_, reject) => (rejectStale = reject));
        }
        return { ok: true };
      },
      onReplaced: (listener) => (replaced = listener),
    },
    snapshot: () => HELD,
  });
  await service.call('setVisibleSessions', [['a'], 1]);
  holdNext = true;
  replaced();
  await service.call('setVisibleSessions', [[], 2]);
  await service.call('setVisibleSessions', [['a'], 3]);
  rejectStale(new Error('gone'));
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  await service.call('setVisibleSessions', [[], 4]);
  assert.deepEqual(
    calls.map((call) => [call.method, call.params.threadId]),
    [['thread/unsubscribe', 'a']],
    'the stale rejection did not drop the newer resume, so hiding the thread still unsubscribes it'
  );
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

test('a method with no request op is refused before anything is sent, with no fallback', async () => {
  const { calls, service } = lane();
  for (const method of SERVICE_NOT_ROUTED) {
    await assert.rejects(service.call(method, []), (error) => error.code === 'unknownMethod', method);
  }
  await assert.rejects(service.call('agentRoomAction', ['reset', ['r1']]), (error) => error.code === 'unknownMethod');
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

test('a client with a service lane never starts the Node service and calls the lane', async () => {
  const { calls, service } = lane();
  let connected = 0;
  const client = new DesktopServiceClient({
    connect: () => {
      connected += 1;
      throw new Error('Node transport must not start');
    },
    sessionOptions: () => ({}),
    serviceLane: service,
  });
  await client.listProjects();
  await client.markSessionRead('t1', 3);
  assert.equal(await client.getSnapshot(), null);
  await client.startTask();
  await assert.rejects(client.getQuotaAutoResume(), (error) => error.code === 'unknownMethod');
  assert.equal(connected, 0);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['project/list', 'thread/readState/update', 'project/taskWorkspace']
  );
});

test('invokeDesktopOperation and notifyDesktopOperation use the operation lane when the client has one', async () => {
  const seen = [];
  const client = new DesktopServiceClient({
    connect: () => {
      throw new Error('Node transport must not start');
    },
    sessionOptions: () => ({}),
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
    connect: () => {
      throw new Error('Node transport must not start');
    },
    sessionOptions: () => ({}),
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
