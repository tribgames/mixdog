// The renderer's session capabilities as core requests (capability-route.ts): the exact op name and params each
// converted capability sends, the capabilities that have no op and so never leave the process, and the lane's wiring
// into a connection. Expectations come from the spec map and the Rust schema (protocol.md section 12.4,
// `operations_map.json`, `client_methods.json`), not from the router.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTION_OVERRIDES,
  OVERRIDE_THREAD_SOURCE,
} from '../../../../../packages/protocol-client/src/actions/action-overrides.mjs';
import { isOfferedRequest } from '../../../../../packages/protocol-client/src/method-table.ts';
import { METHOD_ARGS } from '../../../../../packages/protocol-client/src/actions/method-args.generated.mjs';
import { DESKTOP_CAPABILITIES } from '../../shared/contract-capabilities.ts';
import { createDesktopConnection } from '../connections/desktop-connection.ts';
import { DesktopServiceClient } from '../desktop-service-client.ts';
import {
  DESKTOP_OVERRIDES,
  DESKTOP_OVERRIDE_THREAD_SOURCE,
  createCapabilityLane,
  routeCapability,
} from './capability-route.ts';

const schemaDir = new URL('../../../../../native/core/crates/mixdog-app-protocol/schema/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'));
const specActions = new Map(
  json('operations_map.json')
    .inventory.filter((row) => row.list === 'actions')
    .map((row) => [row.name, row.target])
);
const methodTable = new Map(json('method_table.json').clientMethods.map((row) => [row.method, row]));
const clientMethods = json('client_methods.json');
const paramsSchema = (method) => clientMethods.definitions[clientMethods.methods[method].params.$ref.split('/').pop()];

/** Capabilities with no request op (desktop-gaps-1): the spec map points them at a pushed section or deletes them. They
 *  fail before anything is sent. `noteUserInput` is a notification, sent by the lane and not routed to a request. */
const NOTIFIED = ['noteUserInput'];
const HANDLER_REQUIRES_THREAD = [
  'getBranchMenu',
  'setOutputStyle',
  'setOrchestrationMode',
  'contextStatus',
  'setRoute',
  'setFast',
  'selectBranch',
  'requestWorktree',
];
const NOT_ROUTED = [
  ...NOTIFIED,
  'listPresets',
  'getWebSearchRoute',
  'listAgents',
  'listWorkflows',
  'listProviders',
  'getProviderSetup',
  'getProviderAccounts',
  'getOnboardingStatus',
];

/** A fake core. `calls` are the ops a capability sent; `all` adds the lane's own requests (`thread/start` of the control
 *  thread, `thread/read` of the state a reply carries). `states` is what `thread/read` answers per thread. */
function recordingLane(answer = async () => ({ ok: true })) {
  const calls = [];
  const all = [];
  const states = new Map();
  const world = { starts: 0, failStarts: 0, shell: [], inputs: [], responses: [] };
  const listeners = new Set();
  // The live client's pending set (the library client's: added on an ask the core offers every connection, removed on resolve,
  // dropped with the socket).
  const pending = [];
  const protocol = {
    snapshot: () => ({ status: 'ready', entries: world.shell }),
    noteUserInput: (at) => world.inputs.push(at),
    respond: (id, answer) => world.responses.push({ id, answer }),
    pendingServerRequests: () => pending,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    call: async (method, params) => {
      // The connection's wait for its first open: the client appears, and holds what it starts from then on.
      if (method === 'thread/start' && world.firstOpen) {
        await world.firstOpen;
        if (!link.client) newClient();
      }
      all.push({ method, params });
      if (method === 'thread/start') {
        if (world.failStarts > 0) {
          world.failStarts -= 1;
          throw new Error('core busy');
        }
        world.starts += 1;
        const id = `control-${world.starts}`;
        // The library's client holds the control thread it started (`threadSubscription(id).held`).
        link.client?.held.add(id);
        return { thread: { id } };
      }
      if (method === 'thread/read') {
        const state = states.get(params.threadId) ?? {};
        return { thread: { id: params.threadId }, state, items: [], hasOlder: false };
      }
      calls.push({ method, params });
      return answer(method, params);
    },
  };
  const emit = (event) => {
    if (event.type === 'serverRequest') {
      if (isOfferedRequest(event.request.method)) pending.push(event.request);
    } else if (event.type === 'serverRequestResolved')
      pending.splice(0, pending.length, ...pending.filter((r) => r.id !== event.params.requestId));
    else if (event.type === 'status' && event.status.state !== 'ready') pending.length = 0;
    listeners.forEach((listener) => listener(event));
  };
  // The client the connection exposes: what it holds (`threadSubscription`) and what it was told to let go (`unsubscribeThread`).
  const link = { client: null, released: [] };
  const newClient = () =>
    (link.client = {
      held: new Set(),
      threadSubscription(id) {
        return { held: this.held.has(id) };
      },
      async unsubscribeThread(id) {
        this.held.delete(id);
        link.released.push(id);
      },
    });
  newClient();
  protocol.client = () => link.client;
  const replace = () => void newClient(); // a reopen: another client, which holds nothing of the old one's
  return { calls, all, states, world, emit, replace, link, lane: createCapabilityLane({ protocol }) };
}
// The 14 `mcp/*` actions: `[capability, positional args, params without threadId]`. The names are the fields of the
// Rust `Mcp*Params` structs in declared order (`v2/params.rs`).
const SERVER = { name: 'x', url: 'http://127.0.0.1:9/mcp' };
const CONFIG = { type: 'http', url: 'http://127.0.0.1:9/mcp' };
const LOGIN = { openBrowser: false };
const CALLBACK = 'http://127.0.0.1:9/cb?code=c';
const MCP = [
  ['getMcpServerConfig', ['fixture'], 'mcp/getMcpServerConfig', { name: 'fixture' }],
  ['getMcpOAuthLoginStatus', ['flow-1'], 'mcp/getMcpOAuthLoginStatus', { flowId: 'flow-1' }],
  ['mcpStatus', [], 'mcp/mcpStatus', {}],
  ['addMcpServer', [SERVER], 'mcp/addMcpServer', { input: SERVER }],
  ['saveMcpServer', [{ name: 'x', enabled: false }], 'mcp/saveMcpServer', { input: { name: 'x', enabled: false } }],
  ['removeMcpServer', ['fixture'], 'mcp/removeMcpServer', { name: 'fixture' }],
  ['setMcpServerEnabled', ['fixture', true], 'mcp/setMcpServerEnabled', { name: 'fixture', enabled: true }],
  ['reconnectMcp', ['fixture'], 'mcp/reconnectMcp', { name: 'fixture' }],
  ['beginMcpOAuthLogin', ['fixture', LOGIN], 'mcp/beginMcpOAuthLogin', { name: 'fixture', options: LOGIN }],
  ['cancelMcpOAuthLogin', ['flow-1'], 'mcp/cancelMcpOAuthLogin', { flowId: 'flow-1' }],
  [
    'completeMcpOAuthLogin',
    ['flow-1', CALLBACK],
    'mcp/completeMcpOAuthLogin',
    { flowId: 'flow-1', callbackUrl: CALLBACK },
  ],
  ['signOutMcpServer', ['fixture'], 'mcp/signOutMcpServer', { name: 'fixture' }],
  ['probeMcpServerAuth', [CONFIG], 'mcp/probeMcpServerAuth', { cfg: CONFIG }],
  ['enablePluginMcp', [{ id: 'p', name: 'p' }], 'mcp/enablePluginMcp', { plugin: { id: 'p', name: 'p' } }],
];

for (const [capability, args, method, params] of MCP) {
  test(`${capability} on a pane is ${method} for that thread`, async () => {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, args, 'pane-1');
    assert.deepEqual(calls, [{ method, params: { threadId: 'pane-1', ...params } }]);
  });
  test(`${capability} from the control session is ${method} for the control thread`, async () => {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, args, undefined);
    assert.deepEqual(calls, [{ method, params: { threadId: 'control-1', ...params } }]);
  });
}

test('the 14 mcp actions are the whole mcp namespace of the method table', () => {
  assert.deepEqual(
    MCP.map(([, , method]) => method).sort(),
    [...methodTable.keys()].filter((method) => method.startsWith('mcp/')).sort()
  );
});

test('a reply carries the state of the addressed thread, read from the core at that moment', async () => {
  const { all, lane, states, world } = recordingLane(async () => ({ servers: [] }));
  world.shell = [{ section: 'hostShellJobs', key: null, revision: 3, value: [{ id: 'job-1' }] }];
  states.set('pane-1', { route: { sessionModel: 'm1' }, runtime: { busy: true } });
  const first = await lane.invoke('mcpStatus', [], 'pane-1');
  assert.deepEqual(first.value, { servers: [] });
  assert.equal(first.snapshot.sessionId, 'pane-1');
  assert.equal(first.snapshot.sessionModel, 'm1');
  assert.equal(first.snapshot.busy, true);
  assert.deepEqual(first.snapshot.hostShellJobs, [{ id: 'job-1' }]);
  assert.equal(first.snapshot.toolApproval, null);
  // The thread moved between two calls: the second reply shows it, nothing was kept from the first.
  states.set('pane-1', { route: { sessionModel: 'm2' } });
  const second = await lane.invoke('mcpStatus', [], 'pane-1');
  assert.equal(second.snapshot.sessionModel, 'm2');
  assert.equal(second.snapshot.busy, undefined);
  assert.deepEqual(
    all.filter((call) => call.method === 'thread/read'),
    [
      { method: 'thread/read', params: { threadId: 'pane-1', window: { none: true } } },
      { method: 'thread/read', params: { threadId: 'pane-1', window: { none: true } } },
    ]
  );
});

// The capabilities whose op takes the session as `threadId`, derived from the ops themselves: routed for a session, `threadId`
// is the session and the Rust schema declares it. An op that names its target in an argument (`deleteSession`) is not one.
const SESSION_CALLS = DESKTOP_CAPABILITIES.filter((capability) => {
  if (NOT_ROUTED.includes(capability)) return false;
  const { method, params } = routeCapability(capability, [], 'pane-1');
  return params.threadId === 'pane-1' && 'threadId' in paramsSchema(method).properties;
});

test('a call that takes a session, without one, names the control thread; a call whose op has none names no thread', async () => {
  assert.ok(SESSION_CALLS.length > 100);
  // retryFailedTurn is the one whose thread is an argument that falls back to the call's session when left out.
  for (const capability of [...SESSION_CALLS, 'retryFailedTurn']) {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, [], undefined);
    await lane.invoke(capability, [], 'pane-1');
    assert.equal(calls.length, 2, capability);
    assert.deepEqual(
      calls.map((call) => call.params.threadId),
      ['control-1', 'pane-1'],
      capability
    );
    assert.equal(calls[0].method, calls[1].method, capability);
  }
  const others = DESKTOP_CAPABILITIES.filter(
    (capability) =>
      !NOT_ROUTED.includes(capability) && !SESSION_CALLS.includes(capability) && capability !== 'retryFailedTurn'
  );
  for (const capability of others) {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, [], undefined);
    assert.ok(!('threadId' in (calls[0]?.params ?? {})), capability);
  }
});

// These were outside the lane's hand lists (`THREAD_REQUIRED_CAPABILITIES`, `MCP_CAPABILITIES`), so the core got no `threadId`
// and answered from the user cwd or its own folder. Node serves every one from the control session.
test('the capabilities no list named reach the control thread without a session', async () => {
  for (const capability of [
    'toolsStatus',
    'listInstructionFiles',
    'getInstructionFile',
    'saveInstructionFile',
    'resetInstructionFile',
    'setInstructionFiles',
    'memoryControl',
    'recall',
    'skillsStatus',
    'reloadSkills',
  ]) {
    const { calls, lane } = recordingLane();
    await lane.invoke(capability, [], undefined);
    assert.equal(calls[0].params.threadId, 'control-1', capability);
  }
});

test('a call whose op has no threadId names no thread', async () => {
  const { calls, lane } = recordingLane();
  await lane.invoke('listProviderModels', [{ quick: false }], undefined);
  assert.deepEqual(calls, [{ method: 'model/list', params: { quick: false } }]);
});
test('a reply shows the approvals the core is waiting on for its thread, as the library projects them', async () => {
  const { emit, lane } = recordingLane();
  const ask = (id, thread, order) => ({
    type: 'serverRequest',
    request: {
      id,
      method: 'item/tool/requestApproval',
      params: { threadId: thread, turnId: 't', itemId: `i${id}`, order, request: { name: 'shell' } },
    },
  });
  emit(ask(7, 'pane-1', 1));
  emit(ask(8, 'pane-1', 2));
  emit(ask(9, 'pane-2', 1));
  const shown = (await lane.invoke('mcpStatus', [], 'pane-1')).snapshot;
  assert.equal(shown.toolApproval.id, '7');
  assert.equal(shown.toolApproval.name, 'shell');
  assert.equal(shown.toolApprovalsWaiting, 1);
  emit({ type: 'serverRequestResolved', params: { requestId: 7 } });
  const next = (await lane.invoke('mcpStatus', [], 'pane-1')).snapshot;
  assert.equal(next.toolApproval.id, '8');
  assert.equal(next.toolApprovalsWaiting, 0);
  emit({ type: 'status', status: { state: 'reconnecting' } });
  const dropped = (await lane.invoke('mcpStatus', [], 'pane-1')).snapshot;
  assert.equal(dropped.toolApproval, null);
});

test('a call without a session is answered with the state of the control thread', async () => {
  const { lane, states } = recordingLane();
  states.set('control-1', { route: { sessionProvider: 'openai', sessionModel: 'main' } });
  const { snapshot } = await lane.invoke('getAutoClear', [], undefined);
  assert.equal(snapshot.sessionId, 'control-1');
  assert.equal(snapshot.sessionModel, 'main');
});

test('retryFailedTurn keeps the session it names, and takes the addressed thread when it names none', async () => {
  const { calls, lane } = recordingLane();
  await lane.invoke('retryFailedTurn', ['pane-9', 'turn-1'], undefined);
  await lane.invoke('retryFailedTurn', [undefined, 'turn-2'], undefined);
  await lane.invoke('retryFailedTurn', [undefined, 'turn-3'], 'pane-2');
  await lane.invoke('retryFailedTurn', ['pane-9', 'turn-4'], 'pane-2');
  assert.deepEqual(calls, [
    { method: 'turn/retryFailed', params: { threadId: 'pane-9', turnKey: 'turn-1' } },
    { method: 'turn/retryFailed', params: { threadId: 'control-1', turnKey: 'turn-2' } },
    { method: 'turn/retryFailed', params: { threadId: 'pane-2', turnKey: 'turn-3' } },
    { method: 'turn/retryFailed', params: { threadId: 'pane-9', turnKey: 'turn-4' } },
  ]);
});

// Every override declares where its thread comes from (`OVERRIDE_THREAD_SOURCE`, `DESKTOP_OVERRIDE_THREAD_SOURCE`); the
// declaration is checked against what the override builds, and the lane routes on the declaration alone.
test('every override declares its thread source, and the declaration is what the override does', () => {
  assert.deepEqual(Object.keys(OVERRIDE_THREAD_SOURCE).sort(), Object.keys(ACTION_OVERRIDES).sort());
  assert.deepEqual(Object.keys(DESKTOP_OVERRIDE_THREAD_SOURCE).sort(), Object.keys(DESKTOP_OVERRIDES).sort());
  const declared = { ...OVERRIDE_THREAD_SOURCE, ...DESKTOP_OVERRIDE_THREAD_SOURCE };
  for (const [capability, source] of Object.entries(declared)) {
    assert.ok(['session', 'argument', 'argument-else-session', 'none'].includes(source), `${capability}: ${source}`);
    const withSession = routeCapability(capability, [], 'pane-1');
    const without = routeCapability(capability, [], undefined);
    if (source === 'session') assert.equal(withSession.params.threadId, 'pane-1', capability);
    else if (source === 'none') assert.deepEqual(withSession, without, capability);
    // `inheritFrom` also binds the call's session as the heir (`intoThreadId`); its `threadId` is the argument's.
    else if (source === 'argument')
      assert.equal(
        withSession.params.threadId,
        without.params.threadId,
        `${capability}: the call's session is not its thread`
      );
  }
  assert.equal(routeCapability('retryFailedTurn', [undefined, 't'], 'pane-1').params.threadId, undefined);
});

// An explicit target is whatever id the caller names, a valid session id included, `control-1` the control thread's and the
// ids a routing helper might pick for itself too: it is never taken for the call's session and the request is as routed.
test('an explicit target is never rerouted, whatever valid id it holds', async () => {
  const targets = ['session-probe', 'control-1', 'pane-1', 'sess_0123456789abcdef'];
  const withTarget = {
    inheritFrom: (id) => [id, { compact: false }],
    deleteSession: (id) => [id],
    deleteSessionIfIdle: (id) => [id, 'turn-1'],
    renameSessionTitle: (id) => [id, 'title'],
    scheduleQuotaResume: (id) => [id],
    cancelQuotaResume: (id) => [id],
    continueSessionInModel: (id) => [id, { provider: 'openai', model: 'gpt-5' }],
    retryFailedTurn: (id) => [id, 'turn-1'],
  };
  const arguments_ = Object.entries(OVERRIDE_THREAD_SOURCE)
    .filter(([, source]) => source.startsWith('argument'))
    .map(([name]) => name);
  assert.deepEqual(Object.keys(withTarget).sort(), arguments_.sort());
  for (const [capability, build] of Object.entries(withTarget)) {
    for (const id of targets) {
      const { calls, lane } = recordingLane(async (method) =>
        method === 'thread/fork' ? { thread: { id: 'heir' } } : { ok: true }
      );
      await lane.invoke(capability, build(id), undefined);
      assert.deepEqual(calls, [routeCapability(capability, build(id), undefined)], `${capability}(${id})`);
    }
  }
  const { calls, lane } = recordingLane(async () => ({ thread: { id: 'heir-1' } }));
  await lane.invoke('inheritFrom', ['session-probe', { compact: false }], 'heir-1');
  assert.deepEqual(calls, [
    { method: 'thread/fork', params: { threadId: 'session-probe', intoThreadId: 'heir-1', compact: false } },
  ]);
});

test('the control thread is a control-kind thread started once and kept', async () => {
  const { all, lane } = recordingLane();
  await lane.invoke('getAutoClear', [], undefined);
  await lane.invoke('getAutoClear', [], undefined);
  await lane.invoke('mcpStatus', [], 'pane-1');
  assert.deepEqual(
    all.filter((call) => call.method === 'thread/start'),
    [{ method: 'thread/start', params: { kind: 'control' } }]
  );
});

// The incident: the control thread a `thread/start` subscribed lost its subscriber after the library redialled, was unloaded and
// swept, and the lane still named it. The client now holds and resumes the thread it started (packages/protocol-client
// control-thread-held.test.ts); the lane keeps its id for as long as the current client holds it.
const RESIZE = [{ data: 'AAAA', mimeType: 'image/png' }];
const resizedOn = (calls) =>
  calls.filter((call) => call.method === 'thread/resizeImage').map((call) => call.params.threadId);

test('a control thread the client holds stays the one named, across any number of calls', async () => {
  const { calls, lane, world } = recordingLane();
  for (let n = 0; n < 3; n++) await lane.invoke('resizeImage', RESIZE, undefined);
  assert.equal(world.starts, 1);
  assert.deepEqual(resizedOn(calls), ['control-1', 'control-1', 'control-1']);
});

test('a control thread the client no longer holds (the core lost it) is replaced by a new one', async () => {
  const { calls, lane, link, world } = recordingLane();
  await lane.invoke('resizeImage', RESIZE, undefined);
  link.client.held.delete('control-1');
  await lane.invoke('resizeImage', RESIZE, undefined);
  await lane.invoke('resizeImage', RESIZE, undefined);
  assert.equal(world.starts, 2);
  assert.deepEqual(resizedOn(calls), ['control-1', 'control-2', 'control-2']);
});

test('a replaced client does not hold the old control thread: the lane starts one on the new client, once', async () => {
  const { calls, lane, replace, world } = recordingLane();
  await lane.invoke('resizeImage', RESIZE, undefined);
  replace();
  await Promise.all([lane.invoke('resizeImage', RESIZE, undefined), lane.invoke('resizeImage', RESIZE, undefined)]);
  assert.equal(world.starts, 2);
  assert.deepEqual(resizedOn(calls), ['control-1', 'control-2', 'control-2']);
});

// A call made before the first client is exposed: the connection waits for the first open and starts the thread on the live
// client, which holds it; a concurrent call joins that start, so there is one control thread.
test('calls made before the first connection start one control thread', async () => {
  const { calls, lane, link, world } = recordingLane();
  link.client = null;
  let open;
  world.firstOpen = new Promise((resolve) => (open = resolve));
  const first = lane.invoke('resizeImage', RESIZE, undefined);
  const joined = lane.invoke('resizeImage', RESIZE, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  open();
  await Promise.all([first, joined]);
  await lane.invoke('resizeImage', RESIZE, undefined);
  assert.equal(world.starts, 1);
  assert.deepEqual(resizedOn(calls), ['control-1', 'control-1', 'control-1']);
});

// A failed call is that call's failure: the thread is still the client's and still held, so nothing is started, released or sent again.
test('a failed call leaves the held control thread in place and is not sent again', async () => {
  const { calls, lane, link, world } = recordingLane(async () => {
    throw new Error('refused');
  });
  for (const capability of ['clear', 'mcpStatus'])
    await assert.rejects(lane.invoke(capability, [], undefined), /refused/);
  assert.equal(world.starts, 1);
  assert.deepEqual(link.released, []);
  assert.deepEqual([...link.client.held], ['control-1']);
  assert.equal(calls.length, 2, 'each capability was sent once');
});

// Ownership is settled before a capability names the thread: the client's resume after a redial has ended first, and a thread the
// core refused to resume is not named; the lane starts a new one and sends once to it.
test('a capability waits for the client to settle the control thread, and a thread it lost is never named', async () => {
  const { calls, lane, link, world } = recordingLane();
  await lane.invoke('resizeImage', RESIZE, undefined);
  let settle;
  const gate = new Promise((resolve) => (settle = resolve));
  link.client.whenHeldSettled = () => gate;
  const pending = lane.invoke('resizeImage', RESIZE, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'nothing is sent while the resume is unanswered');
  link.client.held.delete('control-1'); // the core refused the resume
  settle();
  await pending;
  assert.equal(world.starts, 2);
  assert.deepEqual(resizedOn(calls), ['control-1', 'control-2']);
});
test('a failed start of the control thread is tried again by the next call', async () => {
  const { lane, world } = recordingLane();
  world.failStarts = 1;
  await assert.rejects(lane.invoke('clear', [], undefined), /core busy/);
  const { value } = await lane.invoke('clear', [], undefined);
  assert.deepEqual(value, { ok: true });
  assert.equal(world.starts, 1);
});

test('clear asks for the prompt rebuild only with rebuildPrompt, and inheritFrom answers as Node does', async () => {
  const { calls, lane } = recordingLane(async (method) =>
    method === 'thread/fork'
      ? { thread: { id: 'heir-1' }, messages: 3, provider: 'openai', model: 'gpt-5' }
      : { promptRebuilt: true }
  );
  const rebuilt = await lane.invoke('clear', [{ rebuildPrompt: true, archiveAs: 'sess_x' }], 'pane-1');
  assert.deepEqual(rebuilt.value, { promptRebuilt: true });
  await lane.invoke('clear', [{ rebuildPrompt: false }], 'pane-1');
  await lane.invoke('clear', [], 'pane-1');
  assert.deepEqual(calls, [
    { method: 'thread/clear', params: { threadId: 'pane-1', rebuildPrompt: true } },
    { method: 'thread/clear', params: { threadId: 'pane-1' } },
    { method: 'thread/clear', params: { threadId: 'pane-1' } },
  ]);
  calls.length = 0;
  const inherited = await lane.invoke('inheritFrom', ['src-1', { compact: false }], 'heir-1');
  assert.deepEqual(inherited.value, {
    sessionId: 'heir-1',
    sourceSessionId: 'src-1',
    messages: 3,
    provider: 'openai',
    model: 'gpt-5',
  });
  assert.deepEqual(calls, [
    { method: 'thread/fork', params: { threadId: 'src-1', intoThreadId: 'heir-1', compact: false } },
  ]);
});

test('the desktop-only overrides send the ops the spec maps them to', () => {
  assert.deepEqual(routeCapability('getBotOrder', [], undefined), { method: 'config/getBotOrder', params: {} });
  assert.deepEqual(routeCapability('getBotOrder', [], 's1'), {
    method: 'config/getBotOrder',
    params: { threadId: 's1' },
  });
  assert.deepEqual(routeCapability('setBotOrder', [['a', 'b']], undefined), {
    method: 'config/setBotOrder',
    params: { order: ['a', 'b'] },
  });
  const route = { provider: 'openai', model: 'm', onlyIfEmpty: true };
  assert.deepEqual(routeCapability('setAgentRoute', ['bot', route], undefined), {
    method: 'route/set',
    params: { agentId: 'bot', route },
  });
});

test('the actions the TUI routes by override keep their ops on the desktop', () => {
  assert.deepEqual(routeCapability('setFast', [true], 's1'), {
    method: 'fast/set',
    params: { threadId: 's1', on: true },
  });
  assert.deepEqual(routeCapability('setRoute', [{ provider: 'p', model: 'm' }], 's1'), {
    method: 'route/set',
    params: { threadId: 's1', route: { provider: 'p', model: 'm' } },
  });
  assert.deepEqual(routeCapability('listProviderModels', [{ quick: false }], undefined), {
    method: 'model/list',
    params: { quick: false },
  });
});

test('every capability the desktop declares is in the spec map', () => {
  assert.deepEqual(
    [...DESKTOP_CAPABILITIES].filter((capability) => !specActions.has(capability)),
    []
  );
});

test('every routed capability sends the op the spec map names, with params the Rust schema declares', () => {
  const routed = DESKTOP_CAPABILITIES.filter((capability) => !NOT_ROUTED.includes(capability));
  assert.equal(routed.length + NOT_ROUTED.length, DESKTOP_CAPABILITIES.length);
  for (const capability of routed) {
    const target = specActions.get(capability);
    const wanted = target.kind === 'method' ? [target.target] : target.kind === 'methods' ? target.target : [];
    const { method } = routeCapability(capability, [], 'pane-1');
    assert.ok(wanted.includes(method), `${capability} -> ${method}, spec ${JSON.stringify(target)}`);
    assert.ok(methodTable.has(method), `${method} is a client method`);
    const schema = paramsSchema(method);
    const verbatim = !Object.hasOwn(ACTION_OVERRIDES, capability) && Object.hasOwn(METHOD_ARGS, method);
    // A verbatim action is given a value for every position it has; an override only its thread.
    const given = verbatim ? ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'].slice(0, METHOD_ARGS[method].args.length) : [];
    const { params } = routeCapability(capability, given, 'pane-1');
    for (const name of Object.keys(params)) {
      assert.ok(name in schema.properties, `${capability}: ${name} is a param of ${method}`);
    }
    assert.equal('threadId' in params, 'threadId' in schema.properties, `${capability}: threadId follows the schema`);
    if (verbatim) {
      for (const name of (schema.required ?? []).filter((required) => required !== 'opId')) {
        assert.ok(name in params, `${capability}: ${method} requires ${name}`);
      }
    }
  }
  // The ops that cannot run without a thread are session calls, which the lane addresses to the control thread: the ones whose
  // schema requires it, and the eight whose optional `threadId` the Rust handler needs (`thread_of`, or `null` without one).
  const requiresThread = routed.filter((capability) =>
    (paramsSchema(routeCapability(capability, [], 'pane-1').method).required ?? []).includes('threadId')
  );
  for (const capability of [
    ...requiresThread,
    ...HANDLER_REQUIRES_THREAD.filter((name) => DESKTOP_CAPABILITIES.includes(name)),
  ])
    assert.ok(SESSION_CALLS.includes(capability) || capability === 'retryFailedTurn', capability);
  for (const capability of HANDLER_REQUIRES_THREAD) {
    const { method } = routeCapability(capability, [], 'pane-1');
    assert.ok(
      !(paramsSchema(method).required ?? []).includes('threadId'),
      `${capability}: the schema leaves threadId optional`
    );
  }
});

test('a capability with no op fails before anything is sent, and does not fall back', async () => {
  const { all, calls, lane } = recordingLane();
  for (const capability of NOT_ROUTED.filter((name) => !NOTIFIED.includes(name))) {
    await assert.rejects(lane.invoke(capability, [], 'pane-1'), (error) => error.code === 'unknownMethod', capability);
    // Without a session too: no control thread is started for an action that has no op.
    await assert.rejects(lane.invoke(capability, [], undefined), (error) => error.code === 'unknownMethod', capability);
  }
  assert.deepEqual(calls, []);
  const [result] = await lane.read([{ capability: 'listAgents' }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /no protocol method/);
  assert.deepEqual(calls, []);
  assert.deepEqual(all, []);
});

test('reads are answered together, in order, from the control session whatever sessionId they name', async () => {
  const { all, calls, lane } = recordingLane(async (method) => {
    if (method === 'mcp/mcpStatus') throw new Error('status unavailable');
    return method;
  });
  const results = await lane.read([
    { capability: 'getAutoClear' },
    { capability: 'mcpStatus', sessionId: 'pane-1' },
    { capability: 'skillsStatus', args: [{ cwd: '/w' }], sessionId: 'pane-2' },
  ]);
  assert.deepEqual(results, [
    { ok: true, value: 'config/getAutoClear' },
    { ok: false, error: 'status unavailable' },
    { ok: true, value: 'skills/skillsStatus' },
  ]);
  // The MCP read waits for the control thread to start, so the ops reach the core in no fixed order.
  const byMethod = (left, right) => left.method.localeCompare(right.method);
  assert.deepEqual(
    [...calls].sort(byMethod),
    [
      { method: 'config/getAutoClear', params: { threadId: 'control-1' } },
      { method: 'mcp/mcpStatus', params: { threadId: 'control-1' } },
      { method: 'skills/skillsStatus', params: { threadId: 'control-1', options: { cwd: '/w' } } },
    ].sort(byMethod)
  );
  // readCapabilities never reads a request's sessionId, and a read reads no state; only the MCP read is addressed
  // to the control thread, which it starts once.
  assert.deepEqual(
    all.filter((call) => call.method === 'thread/start'),
    [{ method: 'thread/start', params: { kind: 'control' } }]
  );
  assert.deepEqual(
    all.filter((call) => call.method !== 'thread/start'),
    calls
  );
});

test('a domain error of the core reaches the window as the error Node raised', async () => {
  const failure = Object.assign(new Error('rpc'), {
    detail: {
      kind: 'rpc',
      data: {
        reason: 'domainError',
        message: 'Server not found',
        code: 'MCP_SERVER_UNKNOWN',
        detail: { type: 'x', name: 'fixture' },
      },
    },
  });
  const { lane } = recordingLane(async () => {
    throw failure;
  });
  await assert.rejects(lane.invoke('removeMcpServer', ['fixture'], undefined), (error) => {
    assert.equal(error.message, 'Server not found');
    assert.equal(error.code, 'MCP_SERVER_UNKNOWN');
    return true;
  });
});

test('the service client sends capabilities to its lane and never to a local service', async () => {
  const { calls, lane } = recordingLane();
  const client = new DesktopServiceClient({
    connect() {
      throw new Error('a local service must not be reached');
    },
    sessionOptions: () => ({}),
    capabilityLane: lane,
  });
  await client.invokeCapability('setMcpServerEnabled', ['fixture', false], 'pane-1');
  await client.readCapabilities([{ capability: 'mcpStatus' }]);
  assert.deepEqual(calls, [
    { method: 'mcp/setMcpServerEnabled', params: { threadId: 'pane-1', name: 'fixture', enabled: false } },
    { method: 'mcp/mcpStatus', params: { threadId: 'control-1' } },
  ]);
});

test("a connection with a core endpoint routes its client's capabilities through that core", async () => {
  const calls = [];
  const protocol = {
    call: async (method, params) => {
      calls.push({ method, params });
      return { servers: [] };
    },
    snapshot: () => ({ status: 'ready', entries: [] }),
    onEvent: () => () => {},
    onStoreChange: () => () => {},
    onReplaced: () => () => {},
    watchSection: () => () => {},
    pendingServerRequests: () => [],
    close: async () => {},
  };
  const connection = createDesktopConnection(
    { id: 'local', kind: 'local', name: 'PC' },
    {
      sessionOptions: () => ({
        userDataPath: '',
        packaged: false,
        resourcesPath: '',
        appPath: '',
        appVersion: '0.0.0',
        rendererDir: '',
      }),
      appVersion: '0.0.0',
      createProtocol: () => protocol,
    }
  );
  try {
    assert.equal(typeof connection.client.options.operationLane?.invoke, 'function');
    const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
    assert.deepEqual(result.value, { servers: [] });
    assert.deepEqual(calls, [
      { method: 'mcp/mcpStatus', params: { threadId: 'pane-7' } },
      { method: 'thread/read', params: { threadId: 'pane-7', window: { none: true } } },
    ]);
  } finally {
    await connection.dispose();
  }
});

test('the queue, review and model actions send the exact op and params of desktop-gaps-1', () => {
  const at = (capability, args, session = 's1') => routeCapability(capability, args, session);
  assert.deepEqual(at('prioritizeQueued', ['q1']), {
    method: 'turn/steer',
    params: { threadId: 's1', queuedId: 'q1' },
  });
  assert.deepEqual(at('restoreQueued', ['typed', 'q1']), {
    method: 'thread/queue/delete',
    params: { threadId: 's1', queuedId: 'q1', currentText: 'typed', restore: true },
  });
  assert.deepEqual(at('getSessionReviewDiff', []), {
    method: 'review/diff/get',
    params: { threadId: 's1', scope: 'session' },
  });
  assert.deepEqual(at('getSessionReviewFilePatch', ['a.ts', 'b.ts']), {
    method: 'review/diff/get',
    params: { threadId: 's1', scope: 'session', path: 'a.ts', oldPath: 'b.ts' },
  });
  assert.deepEqual(at('getSessionReviewFilePatch', ['a.ts']).params, {
    threadId: 's1',
    scope: 'session',
    path: 'a.ts',
  });
  assert.deepEqual(at('getTurnReviewDiff', [{ summary: true, known: 'k', refresh: true, poll: true }]), {
    method: 'review/diff/get',
    params: { threadId: 's1', scope: 'turn', summary: true, known: 'k' },
  });
  assert.deepEqual(at('getTurnReviewDiff', [{ summary: false }]).params, { threadId: 's1', scope: 'turn' });
  assert.deepEqual(at('getTurnReviewDiff', []).params, { threadId: 's1', scope: 'turn' });
  assert.deepEqual(at('getTurnReviewFilePatch', ['a.ts']), {
    method: 'review/diff/get',
    params: { threadId: 's1', scope: 'turn', path: 'a.ts' },
  });
  assert.deepEqual(at('getTurnChanges', [{ checkpointId: 'c1', patch: true, file: 'a.ts' }]), {
    method: 'review/diff/get',
    params: { threadId: 's1', scope: 'turn', checkpointId: 'c1', patch: true, path: 'a.ts' },
  });
  assert.deepEqual(at('setModel', ['gpt']), {
    method: 'route/set',
    params: { threadId: 's1', route: { model: 'gpt' } },
  });
});

test('setEffort, setToolMode and setModel answer the effort, nothing and true, not the core route reply', async () => {
  const value = async (capability, args, reply) => {
    const { lane } = recordingLane(async () => reply);
    return (await lane.invoke(capability, args, 'pane-1')).value;
  };
  assert.equal(await value('setEffort', ['high'], { model: 'gpt', effort: 'low', effectiveEffort: 'high' }), 'high');
  assert.equal(await value('setEffort', ['low'], { model: 'gpt', effort: 'low' }), 'low');
  assert.equal(await value('setEffort', ['x'], { model: 'gpt', preset: { effort: 'medium' } }), 'medium');
  assert.equal(await value('setEffort', ['auto'], { model: 'gpt' }), 'auto');
  assert.equal(await value('setToolMode', ['full'], 'full'), undefined);
  assert.equal(await value('setModel', ['gpt'], { model: 'gpt', provider: 'openai' }), true);
});

test('noteUserInput is the client/activity notification: it sends no request and answers { ok: true }', async () => {
  const { all, lane, world } = recordingLane();
  const result = await lane.invoke('noteUserInput', [1234], 'pane-1');
  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(world.inputs, [1234]);
  assert.deepEqual(
    all.filter((call) => call.method !== 'thread/read'),
    []
  );
});

const notAvailable = Object.assign(new Error('rpc'), {
  detail: { kind: 'rpc', data: { reason: 'domainError', domain: 'thread', message: 'Session is not available.' } },
});

function renameClient(returned) {
  const { all, lane } = recordingLane(async () => {
    if (returned === false) throw notAvailable;
    return { ok: true };
  });
  const client = new DesktopServiceClient({
    connect() {
      throw new Error('a local service must not be reached');
    },
    sessionOptions: () => ({}),
    capabilityLane: lane,
  });
  return { all, client };
}

test('renameSession on a core connection is thread/name/set with the normalized title', async () => {
  const { all, client } = renameClient(true);
  await client.renameSession('sess-1', '  Spaced   out  ');
  assert.deepEqual(
    all.filter((call) => call.method === 'thread/name/set'),
    [{ method: 'thread/name/set', params: { threadId: 'sess-1', title: 'Spaced out' } }]
  );
});

test('renameSession validates before sending and gives the window the core refusal for valid titles', async () => {
  const titles = [
    ['', null],
    [' \n\t ', null],
    ['<file>attached text</file>', null],
    ['[Pasted text #1]', null],
    ['Roadmap', 'Roadmap'],
    ['  A\tnew\n title  ', 'A new title'],
    ['작업 계획', '작업 계획'],
    ['Issue #42!', 'Issue #42!'],
    ['a'.repeat(100), 'a'.repeat(100)],
    ['b'.repeat(101), `${'b'.repeat(99)}…`],
  ];
  for (const [title, normalized] of titles) {
    for (const accepted of [true, false]) {
      const { all, client } = renameClient(accepted);
      const rename = client.renameSession('sess-1', title);
      if (normalized === null) {
        await assert.rejects(rename, { name: 'TypeError', message: 'Session title is invalid.' });
        assert.deepEqual(all, []);
      } else {
        if (accepted) await rename;
        else await assert.rejects(rename, { name: 'Error', message: 'Session is not available.' });
        assert.deepEqual(
          all.filter((call) => call.method === 'thread/name/set'),
          [{ method: 'thread/name/set', params: { threadId: 'sess-1', title: normalized } }]
        );
      }
    }
  }
});

test('renameSession keeps the host check for the session id before the title', async () => {
  const { all, client } = renameClient(true);
  await assert.rejects(client.renameSession('bad id!', ''), { name: 'TypeError', message: 'session id is invalid.' });
  assert.deepEqual(all, []);
});

// On a core connection the host sends the renderer's arguments as they are and the core resolves a project path itself:
// `skills/skillsStatus` reads `options.projectPath` (skills_service.rs `requested_cwd`, folder from
// `SessionProjectWorkspaces`) and the five session-less `project/*Branch*` capabilities read `input.projectPath`
// (project/service.rs `registered_project`). This pins what reaches the core for each of them.
test('a draft skillsStatus names its Project in options, never a folder, and a session call still addresses its thread', async () => {
  const { calls, lane } = recordingLane(async () => ({ cwd: '/resolved' }));
  await lane.invoke('skillsStatus', [{ projectPath: 'C:\\work\\app' }]);
  await lane.read([
    { capability: 'skillsStatus', args: [{ projectPath: 'C:\\work\\app' }] },
    { capability: 'skillsStatus', args: [] },
  ]);
  await lane.invoke('skillsStatus', [{ projectPath: '' }], 'pane-1');
  assert.deepEqual(calls, [
    { method: 'skills/skillsStatus', params: { threadId: 'control-1', options: { projectPath: 'C:\\work\\app' } } },
    { method: 'skills/skillsStatus', params: { threadId: 'control-1', options: { projectPath: 'C:\\work\\app' } } },
    { method: 'skills/skillsStatus', params: { threadId: 'control-1' } },
    { method: 'skills/skillsStatus', params: { threadId: 'pane-1', options: { projectPath: '' } } },
  ]);
});

test('the five skills actions without a session use the control folder and preserve the reply shape', async () => {
  const cwd = 'C:\\work\\skills-project';
  const skill = { name: 'control-skill', description: 'A test skill.' };
  const tools = [{ name: 'shell' }, { name: 'task' }];
  const status = { cwd, count: 1, tools, skills: [{ ...skill, enabled: true }] };
  const afterRemoval = { cwd, count: 0, tools, skills: [] };
  const afterReload = {
    cwd,
    count: 2,
    tools,
    skills: [
      { ...skill, enabled: true },
      { name: 'review-notes', description: 'Review draft notes.', enabled: false },
    ],
  };
  for (const [capability, args, response] of [
    ['skillsStatus', [], status],
    ['addSkill', [skill], { skill, status }],
    ['saveSkill', [{ originalName: skill.name, ...skill, instructions: '# Saved' }], { skill, status }],
    ['removeSkill', [{ name: skill.name }], { skill: { name: skill.name }, status: afterRemoval }],
    ['reloadSkills', [], afterReload],
  ]) {
    const { lane, calls } = recordingLane(async (method, params) => {
      assert.equal(method, `skills/${capability}`);
      assert.equal(params.threadId, 'control-1', capability);
      return structuredClone(response);
    });
    const { value } = await lane.invoke(capability, args);
    assert.equal(calls.length, 1, capability);
    assert.deepEqual(value, response, capability);
  }
});
test('the project-branch capabilities Node resolved through the registry send their projectPath for the core to resolve', () => {
  const projectScoped = {
    getProjectBranchMenu: 'project/getProjectBranchMenu',
    selectProjectBranch: 'project/selectProjectBranch',
    mergeProjectBranch: 'project/mergeProjectBranch',
    inspectProjectBranch: 'project/inspectProjectBranch',
    manageProjectBranch: 'project/manageProjectBranch',
  };
  for (const [capability, method] of Object.entries(projectScoped)) {
    const input = { projectPath: 'C:\\work\\app', branch: 'feature' };
    assert.deepEqual(routeCapability(capability, [input]), { method, params: { input } }, capability);
  }
});

// `inheritFrom` of a source session the core does not have: the core answers `threadNotFound`, the window shows the
// lane's own refusal text.
test('inheritFrom of a missing session is refused with the lane text', async () => {
  const thrown = 'inheritFrom: session src-1 was not found';
  const missing = Object.assign(new Error('rpc'), {
    detail: { kind: 'rpc', code: -32600, data: { reason: 'threadNotFound', threadId: 'src-1' } },
  });
  const { lane } = recordingLane(async () => {
    throw missing;
  });
  await assert.rejects(lane.invoke('inheritFrom', ['src-1', { compact: false }], 'heir-1'), { message: thrown });
  const other = new Error('core busy');
  await assert.rejects(
    recordingLane(async () => {
      throw other;
    }).lane.invoke('inheritFrom', ['src-1'], 'heir-1'),
    other
  );
});

const wireRefusal = (reason, data) =>
  Object.assign(new Error(`-32600 ${reason} ${reason}`), {
    detail: { kind: 'rpc', code: -32600, reason, message: reason, data: { reason, ...data } },
  });

test('rewindToItem returns null for a missing item or a busy session, but propagates other failures', async () => {
  for (const [itemId, refusal] of [
    ['missing-item', wireRefusal('itemNotFound', { threadId: 't1', itemId: 'missing-item' })],
    ['agent-item', wireRefusal('itemNotFound', { threadId: 't1', itemId: 'agent-item' })],
    ['user-item', wireRefusal('preconditionFailed', { expected: 'idle', actual: 'running' })],
  ]) {
    const { lane, calls } = recordingLane(async () => {
      throw refusal;
    });
    const { value } = await lane.invoke('rewindToItem', [itemId], 't1');
    assert.equal(value, null, itemId);
    assert.equal(calls[0].method, 'thread/rewind');
  }
  const other = wireRefusal('turnNotActive', { threadId: 't1' });
  await assert.rejects(
    recordingLane(async () => {
      throw other;
    }).lane.invoke('rewindToItem', ['i1'], 't1'),
    other
  );
});

// A call naming a session the core does not have is refused with the lane's own text.
test('a call naming a session the core does not have is refused with the lane text', async () => {
  const missing = wireRefusal('threadNotFound', { threadId: 'sess_gone' });
  const { lane } = recordingLane(async () => {
    throw missing;
  });
  await assert.rejects(lane.invoke('getTurnReviewDiff', [], 'sess_gone'), {
    message: 'session sess_gone is not available',
  });
});

test('prioritizeQueued reports a count of one for a promoted entry and zero for a missing entry or slash command', async () => {
  for (const [id, accepted, expected] of [
    ['queued', true, { count: 1, ids: ['queued'], priority: 'now' }],
    ['missing', false, { count: 0, ids: [], priority: 'now' }],
    ['slash-command', false, { count: 0, ids: [], priority: 'now' }],
  ]) {
    const { lane } = recordingLane(async () => {
      if (accepted) return { accepted: true, queuedId: id };
      throw wireRefusal('queuedEntryNotFound', { threadId: 't1', queuedId: id });
    });
    const { value } = await lane.invoke('prioritizeQueued', [id], 't1');
    assert.deepEqual(value, expected, id);
  }
  const other = new Error('core busy');
  await assert.rejects(
    recordingLane(async () => {
      throw other;
    }).lane.invoke('prioritizeQueued', ['q1'], 't1'),
    other
  );
});
test('getQuotaAutoResume finds its own config subtree and is on unless it is explicitly false', async () => {
  for (const [stored, enabled] of [
    [false, false],
    [true, true],
    [undefined, true],
    [null, true],
    [0, true],
    ['false', true],
  ]) {
    const { world, lane } = recordingLane();
    world.shell.push({ section: 'config', key: 'desktop', value: { editor: {} } });
    if (stored !== undefined) {
      world.shell.push({ section: 'config', key: 'quotaAutoResume', value: stored });
    }
    assert.equal(await lane.getQuotaAutoResume(), enabled, JSON.stringify(stored));
  }
});

// `resolveToolApprovalForSession` has no request op: the card's `id` is the id of the `item/*` server request the core asked
// (the lane's own projection shows it as a string), and the decision goes to `thread/approval/answer` for the request's own
// thread, without `device` (the core stamps the answering connection's device: `ToolApprovalDecision`). The card is told the
// core's `accepted`: false when another decision resolved the request first.
test("resolveToolApproval answers the server request the card shows with the core's acceptance, and false for an id the core no longer asks", async () => {
  const { emit, lane, calls } = recordingLane(async (_method, params) => ({ accepted: params.approvalId === '7' }));
  const ask = (id, thread, surface) => ({
    type: 'serverRequest',
    request: {
      id,
      method: 'item/tool/requestApproval',
      params: {
        threadId: thread,
        ...(surface ? { surfaceThreadId: surface } : {}),
        turnId: 't',
        itemId: `i${id}`,
        order: 1,
        request: { name: 'shell' },
      },
    },
  });
  emit(ask(7, 'pane-1'));
  emit(ask('req-8', 'sub-1', 'pane-1'));
  assert.equal(
    await lane.resolveToolApproval('pane-1', '7', { approved: true, device: 'PC', response: 'approve' }),
    true
  );
  assert.equal(
    await lane.resolveToolApproval('pane-1', 'req-8', { approved: false, reason: 'no' }),
    false,
    'another decision got in first'
  );
  assert.deepEqual(calls, [
    {
      method: 'thread/approval/answer',
      params: { threadId: 'pane-1', approvalId: '7', result: { approved: true, response: 'approve' } },
    },
    {
      method: 'thread/approval/answer',
      params: { threadId: 'sub-1', approvalId: 'req-8', result: { approved: false, reason: 'no' } },
    },
  ]);
  // Another session's card, an unknown id and a settled one are not answered.
  assert.equal(await lane.resolveToolApproval('pane-2', '7', { approved: true }), false);
  assert.equal(await lane.resolveToolApproval('pane-1', 'nope', { approved: true }), false);
  emit({ type: 'serverRequestResolved', params: { requestId: 7 } });
  assert.equal(await lane.resolveToolApproval('pane-1', '7', { approved: true }), false);
  assert.equal(calls.length, 2);
});

// The core's card shows its own id (`params.card.id`, room_approval.rs `card_id`), not the request's: an answer naming the card's id
// reaches the request, which `thread/approval/answer` names by its own id.
test('resolveToolApproval finds the request by the id its card shows', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit({
    type: 'serverRequest',
    request: {
      id: 12,
      method: 'item/tool/requestApproval',
      params: {
        threadId: 'bot-1',
        turnId: 't',
        itemId: 'i12',
        order: 1,
        request: { name: 'mcp__gmail__send' },
        card: { id: 'itm_abc', kind: 'outbound' },
      },
    },
  });
  assert.equal(
    await lane.resolveToolApproval('bot-1', 'itm_abc', {
      approved: true,
      response: 'edit-and-approve',
      editedArgs: { body: 'x' },
    }),
    true
  );
  assert.deepEqual(calls, [
    {
      method: 'thread/approval/answer',
      params: {
        threadId: 'bot-1',
        approvalId: '12',
        result: { approved: true, response: 'edit-and-approve', editedArgs: { body: 'x' } },
      },
    },
  ]);
});

const askWithCard = (id, thread, cardId, surface) => ({
  type: 'serverRequest',
  request: {
    id,
    method: 'item/tool/requestApproval',
    params: {
      threadId: thread,
      ...(surface ? { surfaceThreadId: surface } : {}),
      turnId: 't',
      itemId: `i${id}`,
      order: Number(id),
      request: { name: 'shell' },
      card: { id: cardId },
    },
  },
});

test('with two derived-id approvals pending on one surface, answering the second answers the second', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit(askWithCard(1, 'pane-1', 'itm_a'));
  emit(askWithCard(2, 'pane-1', 'itm_b'));
  assert.equal(await lane.resolveToolApproval('pane-1', 'itm_b', { approved: true }), true);
  assert.deepEqual(calls, [
    { method: 'thread/approval/answer', params: { threadId: 'pane-1', approvalId: '2', result: { approved: true } } },
  ]);
});

test('an answer from the wrong surface is refused and sends nothing', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit(askWithCard(1, 'pane-1', 'itm_a'));
  emit(askWithCard(2, 'pane-2', 'itm_b'));
  assert.equal(await lane.resolveToolApproval('pane-2', 'itm_a', { approved: true }), false);
  assert.equal(await lane.resolveToolApproval('pane-1', 'itm_b', { approved: true }), false);
  assert.equal(calls.length, 0);
});

test('a derived-id request of a child thread is answered from its surface only, and sent to the owning thread', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit(askWithCard(3, 'sub-1', 'itm_c', 'pane-1'));
  assert.equal(await lane.resolveToolApproval('sub-1', 'itm_c', { approved: true }), false);
  assert.equal(calls.length, 0);
  assert.equal(await lane.resolveToolApproval('pane-1', 'itm_c', { approved: true }), true);
  assert.deepEqual(calls, [
    { method: 'thread/approval/answer', params: { threadId: 'sub-1', approvalId: '3', result: { approved: true } } },
  ]);
});

test('the raw request id still resolves a request that carries a card id, and is refused once it settled', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit(askWithCard(4, 'pane-1', 'itm_d'));
  assert.equal(await lane.resolveToolApproval('pane-1', '4', { approved: true }), true);
  assert.equal(calls[0].params.approvalId, '4');
  emit({ type: 'serverRequestResolved', params: { requestId: 4 } });
  assert.equal(await lane.resolveToolApproval('pane-1', '4', { approved: true }), false);
  assert.equal(await lane.resolveToolApproval('pane-1', 'itm_d', { approved: true }), false);
  assert.equal(calls.length, 1);
});

test('every decision kind is delivered unchanged when the answer names the derived card id', async () => {
  const decisions = [
    { approved: true, remember: 'once' },
    { approved: true, remember: 'session' },
    { approved: true, remember: 'always' },
    { approved: false, reason: 'no' },
  ];
  for (const [index, decision] of decisions.entries()) {
    const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
    emit(askWithCard(10 + index, 'pane-1', `itm_${index}`));
    assert.equal(await lane.resolveToolApproval('pane-1', `itm_${index}`, { ...decision, device: 'PC' }), true);
    assert.deepEqual(calls, [
      {
        method: 'thread/approval/answer',
        params: { threadId: 'pane-1', approvalId: String(10 + index), result: decision },
      },
    ]);
  }
});

// A request this connection holds under another surface (a sub-agent's, shown on its parent chat) is not answered from the child's
// own session id, and a request it does not hold is not sent at all: the answer would otherwise reach whatever the core asks under
// that thread and id.
test('an approval held under another surface, or not held at all, is refused without sending', async () => {
  const { emit, lane, calls } = recordingLane(async () => ({ accepted: true }));
  emit({
    type: 'serverRequest',
    request: {
      id: 'req-8',
      method: 'item/tool/requestApproval',
      params: {
        threadId: 'sub-1',
        surfaceThreadId: 'pane-1',
        turnId: 't',
        itemId: 'i8',
        order: 1,
        request: { name: 'shell' },
      },
    },
  });
  assert.equal(await lane.resolveToolApproval('sub-1', 'req-8', { approved: true }), false);
  assert.equal(await lane.resolveToolApproval('pane-1', 'req-9', { approved: true }), false);
  assert.equal(calls.length, 0);
  assert.equal(await lane.resolveToolApproval('pane-1', 'req-8', { approved: true }), true);
  assert.equal(calls[0].params.threadId, 'sub-1');
});

// The core's control thread is the client's (held, resumed after a redial, never named once lost), so a failed call is
// only that call's failure: the same thread serves the next call and nothing is sent twice.
test("a failed control call is that call's failure, and the next call uses the same control thread", async () => {
  let next = 0;
  const { calls, world, lane } = recordingLane(async (method) => {
    if (next++ === 0) throw new Error('status unavailable');
    return method;
  });
  await assert.rejects(lane.invoke('mcpStatus', []), /status unavailable/);
  assert.equal((await lane.invoke('mcpStatus', [])).value, 'mcp/mcpStatus');
  assert.equal(world.starts, 1);
  assert.deepEqual(
    calls.map((call) => call.params.threadId),
    ['control-1', 'control-1']
  );
});
// session-host-transport.ts `invokeControlResult` awaits `ensureControlSession()` outside its try: a control thread that cannot be
// created is not retried, whatever the call, and its error reaches the caller at once.
test('a failed start of the control thread is not retried, not even for a read', async () => {
  const { calls, lane, world } = recordingLane();
  world.failStarts = 1;
  await assert.rejects(lane.invoke('mcpStatus', []), /core busy/);
  assert.equal(world.starts, 0, 'no second start was made');
  assert.deepEqual(calls, [], 'nothing was sent');
  assert.deepEqual((await lane.invoke('mcpStatus', [])).value, { ok: true });
  assert.equal(world.starts, 1);
});
