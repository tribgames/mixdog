import assert from 'node:assert/strict';
import test from 'node:test';

import { roomSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { createAgentRooms } from './agent-rooms.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import {
  CORE_HOST_ACTIONS,
  createCapabilityLane,
  hostControlAction,
  hostSessionAction,
} from './protocol/capability-route.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';
import { sessionRemoteMethods } from './remote-session-methods.ts';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';

// `renameSession` and the host's own session mutations on a core connection. The host reaches the core through the
// connection's one lane (`runtime.capabilityLane`, handed to the lifecycle as `coreLane`); every caller of the host's
// rename (the window's IPC through the service client, the remote method, the group rooms) ends in it. The Node transport
// (`invokeControl`) is never reached for a converted action.
const SESSION = `sess_desktop_${'a'.repeat(64)}`;
const ROOM = 'room1abc';
const notAvailable = Object.assign(new Error('rpc'), {
  detail: { kind: 'rpc', data: { reason: 'domainError', domain: 'thread', message: 'Session is not available.' } },
});

function coreLane(refuse = false) {
  const calls = [];
  const protocol = {
    snapshot: () => ({ status: 'ready', entries: [] }),
    noteUserInput() {},
    onEvent: () => () => undefined,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: params.threadId }, state: {}, items: [], hasOlder: false };
      if (method === 'thread/name/set' && refuse) throw notAvailable;
      return { ok: true };
    },
  };
  return { calls, lane: createCapabilityLane({ protocol }) };
}

/** The host's lifecycle on a core connection: only the parts a rename touches are real. */
function coreLifecycle(lane) {
  const nodeCalls = [];
  const named = [];
  const lifecycle = new SessionHostLifecycle({
    coreLane: lane,
    invokeControl: async (method) => {
      nodeCalls.push(method);
      throw new Error(`the Node control session must not be reached: ${method}`);
    },
    sessionMetadata: { setName: async (id, title) => named.push([id, title]) },
    publishCatalogs: async () => undefined,
  });
  return { lifecycle, nodeCalls, named };
}

const renames = (calls) => calls.filter((call) => call.method === 'thread/name/set');
const OUTCOMES = [
  { name: 'a title the core accepts', refuse: false, title: '  Quarterly   plan ', sent: 'Quarterly plan', expect: { ok: true } },
  { name: 'a title the core refuses', refuse: true, title: 'Mine', sent: 'Mine', expect: { error: 'Session is not available.', kind: 'Error' } },
  {
    name: 'an empty title',
    refuse: false,
    title: '   ',
    sent: null,
    expect: { error: 'Session title is invalid.', kind: 'TypeError' },
    // The window's IPC and the remote method validate the title before the host (`sessionDisplayName`), as on Node.
    expectBeforeHost: { error: 'title is invalid.', kind: 'TypeError' },
  },
];
const settle = (promise) =>
  promise.then(
    () => ({ ok: true }),
    (error) => ({ error: error.message, kind: error.constructor.name })
  );

for (const outcome of OUTCOMES) {
  const requests = (calls) =>
    outcome.sent === null ? [] : [{ method: 'thread/name/set', params: { threadId: SESSION, title: outcome.sent } }];

  test(`the host's rename on a core connection: ${outcome.name}`, async () => {
    const { calls, lane } = coreLane(outcome.refuse);
    const { lifecycle, nodeCalls, named } = coreLifecycle(lane);
    assert.deepEqual(await settle(lifecycle.renameSession(SESSION, outcome.title)), outcome.expect);
    assert.deepEqual(renames(calls), requests(calls));
    assert.deepEqual(nodeCalls, []);
    // The host's own record of the name follows only an accepted rename.
    assert.deepEqual(named, outcome.expect.ok ? [[SESSION, outcome.sent]] : []);
  });

  test(`the window's rename IPC on a core connection: ${outcome.name}`, async () => {
    const { calls, lane } = coreLane(outcome.refuse);
    const client = new DesktopServiceClient({
      connect() {
        throw new Error('the Node service must not be reached');
      },
      sessionOptions: () => ({}),
      capabilityLane: lane,
    });
    const handlers = new Map();
    registerSessionIpc({ handle: (channel, fn) => handlers.set(channel, fn), host: client, invokeDesktopOperation: async () => undefined });
    assert.deepEqual(
      await settle(Promise.resolve().then(() => handlers.get(DESKTOP_IPC.renameSession)({}, SESSION, outcome.title))),
      outcome.expectBeforeHost ?? outcome.expect
    );
    assert.deepEqual(renames(calls), requests(calls));
  });

  test(`the remote renameSession method on a core connection: ${outcome.name}`, async () => {
    const { calls, lane } = coreLane(outcome.refuse);
    const { lifecycle, nodeCalls } = coreLifecycle(lane);
    // `SessionHost.renameSession` is `this.lifecycle.renameSession`.
    const host = { renameSession: (id, title) => lifecycle.renameSession(id, title) };
    const methods = sessionRemoteMethods(host, undefined, undefined);
    assert.deepEqual(
      await settle(Promise.resolve().then(() => methods.renameSession([SESSION, outcome.title]))),
      outcome.expectBeforeHost ?? outcome.expect
    );
    assert.deepEqual(renames(calls), requests(calls));
    assert.deepEqual(nodeCalls, []);
  });
}

// The rooms swallow a rename failure (agent-rooms.ts update), so both texts end as the same unthrown outcome; what matters
// is that the room's rename reaches the core with the room's session id and name, the Node transport untouched.
for (const refuse of [false, true]) {
  test(`a group room's rename on a core connection reaches the core (${refuse ? 'refused' : 'accepted'})`, async () => {
    const { calls, lane } = coreLane(refuse);
    const { lifecycle, nodeCalls } = coreLifecycle(lane);
    const stored = { id: ROOM, name: 'Stored', members: ['lead', 'gh'], maxRounds: 1, maxMessages: 6, shareTools: false, createdAt: 1, cursors: {}, running: null };
    const saved = { doc: { rooms: { [ROOM]: stored } } };
    const rooms = createAgentRooms({
      store: { load: async () => structuredClone(saved.doc), save: async (doc) => void (saved.doc = structuredClone(doc)) },
      listAgents: async () => [],
      // The binding of session-host.ts: `renameSession: (id, title) => this.lifecycle.renameSession(id, title)`.
      renameSession: (id, title) => lifecycle.renameSession(id, title),
      republishCatalog: () => undefined,
      republish: () => undefined,
      sessionExists: async () => true,
      deleteSession: async () => undefined,
      setArchived: async () => undefined,
    });
    await rooms.update(ROOM, { name: 'Renamed' });
    assert.deepEqual(renames(calls), [{ method: 'thread/name/set', params: { threadId: roomSessionId(ROOM), title: 'Renamed' } }]);
    assert.deepEqual(nodeCalls, []);
    assert.equal(saved.doc.rooms[ROOM].name, 'Renamed');
  });
}

const CONVERTED = [
  { control: true, method: 'deleteSession', args: [SESSION], request: { method: 'thread/delete', params: { threadId: SESSION } } },
  { method: 'stopShellJob', args: ['t1'], request: { method: 'thread/backgroundTerminals/terminate', params: { threadId: SESSION, taskId: 't1' } } },
  { method: 'releaseShellJob', args: ['t1'], request: { method: 'thread/backgroundTerminals/release', params: { threadId: SESSION, taskId: 't1' } } },
  { method: 'setFast', args: [true], request: { method: 'fast/set', params: { threadId: SESSION, on: true } } },
  { method: 'setWorkflow', args: ['wf'], request: { method: 'thread/setWorkflow', params: { threadId: SESSION, workflowId: 'wf' } } },
  { method: 'setOrchestrationMode', args: ['multi'], request: { method: 'thread/setOrchestrationMode', params: { threadId: SESSION, mode: 'multi' } } },
  {
    control: true,
    method: 'setArchivedSessionWorktrees',
    args: [{ sessionIds: ['a', 'b'], archived: true }],
    request: { method: 'project/setArchivedSessionWorktrees', params: { input: { sessionIds: ['a', 'b'], archived: true } } },
  },
  { control: true, method: 'purgeAgentDefinition', args: ['bot'], request: { method: 'agent/purgeAgentDefinition', params: { agentId: 'bot' } } },
];

test('the converted host actions are exactly the ones whose core reply serves the host', () => {
  assert.deepEqual([...CORE_HOST_ACTIONS].sort(), CONVERTED.map((item) => item.method).sort());
});

test('a constructed SessionHost on a core connection sends its converted actions to the core and the rest to Node', async () => {
  const world = await viewSyncHost();
  try {
    const { calls, lane } = coreLane();
    world.runtime.capabilityLane = lane;
    const owner = world.host.lifecycle.owner;
    for (const item of CONVERTED) {
      const before = calls.length;
      const reply = item.control ? await owner.invokeControl(item.method, item.args) : await owner.invokeSession(SESSION, item.method, item.args);
      assert.deepEqual(calls[before], item.request, item.method);
      assert.deepEqual(reply, item.control ? { ok: true } : { value: { ok: true }, snapshot: reply.snapshot, result: {} }, item.method);
    }
    // An action whose reply the host reads stays on the Node transport: the session client answers (and here refuses) it.
    const sent = calls.length;
    await assert.rejects(owner.invokeSession(SESSION, 'setRoute', [{}]), /Unexpected configuration|not available/);
    assert.equal(calls.length, sent);
  } finally {
    await world.close();
  }
});

test('a constructed SessionHost on a core connection keeps session metadata in the core', async () => {
  const world = await viewSyncHost();
  try {
    const { calls, lane } = coreLane();
    world.runtime.capabilityLane = lane;
    const { host } = world;
    await host.setSessionFavorite(SESSION, true);
    await host.archiveSessionAlone(SESSION);
    await host.lifecycle.setSessionArchived(SESSION, false, false);
    await host.forgetSessionMetadata(SESSION);
    assert.deepEqual(calls, [
      { method: 'thread/metadata/update', params: { threadId: SESSION, favorite: true } },
      { method: 'thread/archive', params: { threadId: SESSION } },
      { method: 'thread/unarchive', params: { threadId: SESSION } },
    ]);
    // The Node-side metadata file is not written.
    await host.sessionMetadata.load();
    assert.equal(Object.keys(host.sessionMetadata.favorites).length, 0);
    assert.equal(Object.keys(host.sessionMetadata.archived).length, 0);
    const renamed = await settle(host.renameSession(SESSION, 'Plan'));
    assert.deepEqual(renamed, { ok: true });
    assert.deepEqual(calls.at(-1), { method: 'thread/name/set', params: { threadId: SESSION, title: 'Plan' } });
  } finally {
    await world.close();
  }
});

test('a host without a lane (a Node connection) keeps every action on the Node transport', async () => {
  const world = await viewSyncHost();
  try {
    const owner = world.host.lifecycle.owner;
    await assert.rejects(owner.invokeSession(SESSION, 'setFast', [true]), /Unexpected configuration|not available/);
    assert.equal(owner.coreLane, undefined);
  } finally {
    await world.close();
  }
});
