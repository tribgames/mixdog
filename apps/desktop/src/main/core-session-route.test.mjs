import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createCapabilityLane } from './protocol/capability-route.ts';

// The session methods a window calls on a core connection. There is no Node host on that connection: the lane is the
// whole path (SessionHost is Node-only and K1 deletes it), so each method is one core request and the Node service is
// never reached. The checks of Node's IPC layer stay in `ipc-sessions.ts`; the core repeats them for a phone.
const SESSION = `sess_desktop_${'a'.repeat(64)}`;
const notAvailable = Object.assign(new Error('rpc'), {
  detail: { kind: 'rpc', data: { reason: 'domainError', domain: 'thread', message: 'Session is not available.' } },
});

function coreClient({ refuse = false, config = undefined, answer = async () => ({ ok: true }) } = {}) {
  const calls = [];
  const protocol = {
    snapshot: () => ({ status: 'ready', entries: config === undefined ? [] : [{ section: 'config', value: config }] }),
    noteUserInput() {},
    onEvent: () => () => undefined,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: params.threadId }, state: {}, items: [], hasOlder: false };
      if (method === 'thread/name/set' && refuse) throw notAvailable;
      return answer(method, params);
    },
  };
  const client = new DesktopServiceClient({
    connect() {
      throw new Error('the Node service must not be reached');
    },
    sessionOptions: () => ({}),
    capabilityLane: createCapabilityLane({ protocol }),
  });
  return { calls, client };
}

const settle = (promise) =>
  promise.then(
    () => ({ ok: true }),
    (error) => ({ error: error.message, kind: error.constructor.name })
  );

const OUTCOMES = [
  { name: 'a title the core accepts', refuse: false, title: 'Quarterly plan', sent: true, expect: { ok: true } },
  { name: 'a title the core refuses', refuse: true, title: 'Mine', sent: true, expect: { error: 'Session is not available.', kind: 'Error' } },
  { name: 'an empty title', refuse: false, title: '   ', sent: false, expect: { error: 'title is invalid.', kind: 'TypeError' } },
];

for (const outcome of OUTCOMES) {
  test(`the window's rename IPC on a core connection: ${outcome.name}`, async () => {
    const { calls, client } = coreClient({ refuse: outcome.refuse });
    const handlers = new Map();
    registerSessionIpc({ handle: (channel, fn) => handlers.set(channel, fn), host: client, invokeDesktopOperation: async () => undefined });
    const result = await settle(Promise.resolve().then(() => handlers.get(DESKTOP_IPC.renameSession)({}, SESSION, outcome.title)));
    assert.deepEqual(result, outcome.expect);
    assert.deepEqual(
      calls.filter((call) => call.method === 'thread/name/set'),
      outcome.sent ? [{ method: 'thread/name/set', params: { threadId: SESSION, title: outcome.title } }] : []
    );
  });
}

test('favorite, project and archive are thread metadata and archive requests of the core; the core cascades the archive', async () => {
  const { calls, client } = coreClient();
  await client.setSessionFavorite(SESSION, true);
  await client.setSessionProject(SESSION, '/work/project');
  await client.setSessionProject(SESSION, '');
  await client.setSessionArchived(SESSION, true);
  await client.setSessionArchived(SESSION, false);
  assert.deepEqual(calls, [
    { method: 'thread/metadata/update', params: { threadId: SESSION, favorite: true } },
    { method: 'thread/metadata/update', params: { threadId: SESSION, projectPath: '/work/project' } },
    { method: 'thread/metadata/update', params: { threadId: SESSION, projectPath: '' } },
    { method: 'thread/archive', params: { threadId: SESSION } },
    { method: 'thread/unarchive', params: { threadId: SESSION } },
  ]);
});

test('stopShellJob and releaseShellJob answer as the host did, a failure included', async () => {
  const replies = {
    'thread/backgroundTerminals/terminate': { stopped: false, finished: true, error: 'done already' },
    'thread/backgroundTerminals/release': { released: true },
  };
  const { calls, client } = coreClient({ answer: async (method) => replies[method] });
  assert.deepEqual(await client.stopShellJob(SESSION, 't1'), { stopped: false, finished: true, error: 'done already' });
  assert.deepEqual(await client.releaseShellJob(SESSION, 't1'), { released: true });
  assert.deepEqual(calls, [
    { method: 'thread/backgroundTerminals/terminate', params: { threadId: SESSION, taskId: 't1' } },
    { method: 'thread/backgroundTerminals/release', params: { threadId: SESSION, taskId: 't1' } },
  ]);
  const empty = coreClient({ answer: async () => ({ stopped: false }) });
  assert.deepEqual(await empty.client.stopShellJob(SESSION, 't1'), { stopped: false, error: 'The job was not stopped.' });
  assert.deepEqual(await coreClient({ answer: async () => ({}) }).client.releaseShellJob(SESSION, 't1'), {
    released: false,
    error: 'The job was not released.',
  });
  const failing = coreClient({
    answer: async () => {
      throw new Error('core busy');
    },
  });
  assert.deepEqual(await failing.client.stopShellJob(SESSION, 't1'), { stopped: false, error: 'core busy' });
  assert.deepEqual(await failing.client.releaseShellJob(SESSION, 't1'), { released: false, error: 'core busy' });
});

test('quota auto-resume is the config key quotaAutoResume: read from the section, written with config/value/write', async () => {
  assert.equal(await coreClient({ config: { quotaAutoResume: false } }).client.getQuotaAutoResume(), false);
  assert.equal(await coreClient({ config: { quotaAutoResume: true } }).client.getQuotaAutoResume(), true);
  assert.equal(await coreClient({ config: { desktop: {} } }).client.getQuotaAutoResume(), true, 'on unless false');
  assert.equal(await coreClient().client.getQuotaAutoResume(), true);
  const { calls, client } = coreClient();
  assert.equal(await client.setQuotaAutoResume(false), false);
  assert.equal(await client.setQuotaAutoResume(true), true);
  assert.deepEqual(calls, [
    { method: 'config/value/write', params: { path: 'quotaAutoResume', value: false } },
    { method: 'config/value/write', params: { path: 'quotaAutoResume', value: true } },
  ]);
});

test('deleteSession is thread/delete, and a session the core does not have is a no-op as in Node', async () => {
  const { calls, client } = coreClient();
  await client.deleteSession(SESSION);
  assert.deepEqual(calls, [{ method: 'thread/delete', params: { threadId: SESSION } }]);
  const missing = Object.assign(new Error('rpc'), { detail: { kind: 'rpc', data: { reason: 'threadNotFound' } } });
  const gone = coreClient({
    answer: async () => {
      throw missing;
    },
  });
  await gone.client.deleteSession(SESSION);
  const busy = coreClient({
    answer: async () => {
      throw Object.assign(new Error('rpc'), { detail: { kind: 'rpc', data: { reason: 'overloaded' } } });
    },
  });
  await assert.rejects(busy.client.deleteSession(SESSION), { message: 'rpc' });
});
