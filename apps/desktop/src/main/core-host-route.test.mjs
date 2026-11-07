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

test('the host mutations with a protocol op and an unread reply go to the core; the rest stay on Node', async () => {
  assert.deepEqual([...CORE_HOST_ACTIONS].sort(), ['purgeAgentDefinition', 'setArchivedSessionWorktrees', 'setCwd', 'setOrchestrationMode', 'setWorkflow']);
  const { calls, lane } = coreLane();
  const node = async () => {
    throw new Error('Node');
  };
  await hostSessionAction(lane, SESSION, 'setCwd', ['/work'], node);
  await hostSessionAction(lane, SESSION, 'setWorkflow', ['wf'], node);
  await hostSessionAction(lane, SESSION, 'setOrchestrationMode', ['multi'], node);
  await hostControlAction(lane, 'setArchivedSessionWorktrees', [{ sessionIds: ['a', 'b'], archived: true }], node);
  await hostControlAction(lane, 'purgeAgentDefinition', ['bot'], node);
  assert.deepEqual(
    calls.filter((call) => call.method !== 'thread/read'),
    [
      { method: 'thread/setCwd', params: { threadId: SESSION, path: '/work' } },
      { method: 'thread/setWorkflow', params: { threadId: SESSION, workflowId: 'wf' } },
      { method: 'thread/setOrchestrationMode', params: { threadId: SESSION, mode: 'multi' } },
      { method: 'project/setArchivedSessionWorktrees', params: { input: { sessionIds: ['a', 'b'], archived: true } } },
      { method: 'agent/purgeAgentDefinition', params: { agentId: 'bot' } },
    ]
  );
  // The session reply keeps the shape the host reads; an action whose reply the host reads, or a Node connection, is the Node transport's.
  const reply = await hostSessionAction(lane, SESSION, 'setCwd', ['/w'], node);
  assert.deepEqual(Object.keys(reply).sort(), ['result', 'snapshot', 'value']);
  const before = calls.length;
  await assert.rejects(hostControlAction(lane, 'deleteSession', [SESSION], node), /Node/);
  await assert.rejects(hostSessionAction(lane, SESSION, 'setRoute', [{}], node), /Node/);
  await assert.rejects(hostControlAction(undefined, 'setCwd', [], node), /Node/);
  assert.equal(calls.length, before);
});
