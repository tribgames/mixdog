// The phone's thread list feed (its catalog clock) and the chat adapter: a wired chat call's requests carry that call's claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatAdapter, createRosterFeed } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { normalizedProviderModels } from '../main/desktop-support.ts';
import { remoteToolOutput } from '../main/remote-transcript.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';
import { DIRECT_KEYS } from '../shared/desktop-api-split.ts';

// The router's call deadline reads the page's timers (remote-shim-call-watch.ts); a Node test has no window.
globalThis.window ??= globalThis;

test('edges reach the phone on the catalog clock: 400 ms after the first, no sooner than 2 s after the last refresh', async () => {
  let now = 10_000;
  const timers = [];
  const published = [];
  const feed = createRosterFeed({
    summaries: (rows) => rows.map((row) => `${row.id}:${row.name}`),
    publish: (rows) => published.push({ at: now, rows }),
    timers: { now: () => now, setTimeout: (run, ms) => timers.push({ due: now + ms, run }) },
  });
  let listener;
  feed.attach({
    call: async () => ({ data: [] }),
    on: (l) => {
      listener = l;
      return () => undefined;
    },
    store: { subscribe: () => () => undefined },
  });
  await feed.list({ call: async () => ({ data: [] }) });
  const edge = (name) =>
    listener({
      type: 'notification',
      notification: { method: 'thread/summary/updated', params: { thread: { id: 's', name } } },
    });
  const moveTo = (at) => {
    const earliest = () => timers.filter((x) => x.due <= at).sort((a, b) => a.due - b.due)[0];
    for (let t = earliest(); t; t = earliest()) {
      timers.splice(timers.indexOf(t), 1);
      now = t.due;
      t.run();
    }
    now = at;
  };
  published.length = 0;
  edge('a');
  moveTo(10_100);
  edge('b');
  moveTo(11_000);
  edge('c');
  moveTo(20_000);
  assert.deepEqual(published, [
    { at: 10_400, rows: ['s:b'] },
    { at: 12_400, rows: ['s:c'] },
  ]);
});

// ── PH-1: a wired chat call's requests carry that call's transmission claim ─────────────────────────────────────────────────────────
/** Every request of four chat calls through the real router; `wire` may replace what the adapter is handed. */
async function writtenThrough(wire = (adapter) => adapter) {
  const written = [];
  const client = {
    call: async (method, params, options) => {
      written.push({ method, params, sent: options?.sent });
      return method === 'thread/list' ? { data: [] } : {};
    },
    resumeThread: async (_threadId, _window, options) => {
      written.push({ method: 'thread/resume', sent: options?.sent });
      return {};
    },
    unsubscribeThread: async (_threadId, options) => {
      written.push({ method: 'thread/unsubscribe', sent: options?.sent });
    },
    server: { connection: { device: 'Phone' } },
  };
  const made = [];
  const adapter = createChatAdapter({
    sharedFor: (handed) => {
      made.push(handed);
      const protocol = {
        call: (method, params) => handed.call(method, params),
        snapshot: () => ({ entries: [] }),
        noteUserInput() {},
        respond() {},
        pendingServerRequests: () => [],
      };
      return {
        routeService,
        lane: createCapabilityLane({ protocol }),
        coreErrorForWindow,
        normalizedProviderModels,
        sessionStateOf: () => undefined,
        remoteToolOutput,
        foldRows: () => [],
      };
    },
    remoteSession: () => undefined,
    roster: { summaries: (rows) => summariesOfThreadRows(rows) },
  });
  const host = { ctx: { sessionsCatalog: { publish() {} } }, client: () => client, declareLane() {} };
  const router = createProtocolRouter([wire(adapter, client)], {
    host,
    started: async () => undefined,
    synced: async () => undefined,
    appSynced: async () => undefined,
    probe() {},
    silentSince: () => false,
  });
  await router.call('markSessionRead', ['sess_a', 3, true]);
  await router.call('renameSession', ['sess_a', 'New name']);
  await router.call('listSessions', []);
  await router.call('deleteSession', ['sess_a']).catch(() => undefined);
  return { written, made, client };
}

test('a chat call wired through the router writes every request with its own claim', async () => {
  const { written, made, client } = await writtenThrough();
  for (const request of written)
    assert.equal(typeof request.sent, 'function', `${request.method} carries its call's claim`);
  // Four router calls (markSessionRead, renameSession, listSessions, deleteSession): each has a claim of its own and builds its own adapter.
  assert.equal(new Set(written.map((w) => w.sent)).size, 4, 'each call has a claim of its own');
  assert.equal(made.length, 3, 'the adapter is built per call from the scoped client, not once');
  assert.ok(
    made.every((c) => c !== client),
    "what the adapter was built from is the call's scoped client"
  );
});

// Negative control: the same adapter built once from a captured client (what `install` hands over) loses every claim, so the test above
// would fail for it.
test('negative control: an adapter built once with a captured client writes unclaimed requests', async () => {
  const captured = (adapter, client) => {
    const calls = Object.fromEntries(
      Object.entries(adapter.calls).map(([name, call]) => [
        name,
        (params, host) => call(params, { ...host, client: () => client }),
      ])
    );
    return { ...adapter, calls };
  };
  const { written } = await writtenThrough(captured);
  assert.notEqual(written.length, 0);
  assert.ok(
    written.every((request) => request.sent === undefined),
    'no request carries a claim'
  );
});

// `getSnapshot` answers the host's shell snapshot: null until a start call published one, then that start's blank snapshot with the remote channel as it stands.
test("getSnapshot is null until a start, then the start's blank snapshot with the remote channel as it stands now", async () => {
  let remote;
  const client = {
    call: async (method) => (method === 'project/taskWorkspace' ? { path: 'C:\\ws\\task' } : {}),
    resumeThread: async () => ({}),
    unsubscribeThread: async () => undefined,
    server: { connection: { device: 'Phone' } },
  };
  const adapter = createChatAdapter({
    sharedFor: (handed) => {
      const protocol = {
        call: (method, params) => handed.call(method, params),
        snapshot: () => ({ entries: [] }),
        noteUserInput() {},
        respond() {},
        pendingServerRequests: () => [],
      };
      return {
        routeService,
        lane: createCapabilityLane({ protocol }),
        coreErrorForWindow,
        normalizedProviderModels,
        sessionStateOf: () => undefined,
        foldRows: () => [],
      };
    },
    remoteSession: () => remote,
    roster: { summaries: (rows) => summariesOfThreadRows(rows) },
  });
  const host = { ctx: { sessionsCatalog: { publish() {} } }, client: () => client, declareLane() {} };
  assert.equal(await adapter.calls.getSnapshot([], host), null, 'no shell before a start');
  const started = await adapter.calls.startTask([], host);
  assert.equal(started.cwd, 'C:\\ws\\task');
  assert.deepEqual(await adapter.calls.getSnapshot([], host), started);
  remote = { enabled: true, sessionId: 'sess_remote' };
  assert.deepEqual(await adapter.calls.getSnapshot([], host), {
    ...started,
    remoteEnabled: true,
    remoteSessionId: 'sess_remote',
  });
  const other = { ...host, ctx: { sessionsCatalog: { publish() {} } } };
  assert.equal(await adapter.calls.getSnapshot([], other), null, 'another page holds its own shell');
});

// The session calls of the desktop API (DIRECT_KEYS.sessions) that other phone adapters or the page itself serve, not this one.
const SESSION_CALLS_ELSEWHERE = [
  'deleteAgentMemory',
  'listAgentMemory',
  'listAgentPool',
  'previewSession',
  'readSessionAttachment',
  'resyncSessionState',
  'setVisibleSessions',
  'subscribeAgentPool',
  'subscribeRelayPayloadRefused',
  'subscribeSessionState',
  'subscribeSessions',
  'subscribeState',
];
// What the chat adapter answers beside the session calls: the secret reply, the capability read, the three start calls, and two calls of
// its own (a transcript item read, a fresh recovery of a thread's state).
const CHAT_CALLS_BESIDES = [
  'provideSecretInput',
  'readCapabilities',
  'startProject',
  'startProjectTask',
  'startTask',
  'readTranscriptItem',
  'refreshSessionState',
];

test('the adapter the switch point loads claims exactly the chat calls the desktop API names, each as a function', async () => {
  const { adapter } = await import('./remote-protocol-chat.ts');
  assert.equal(adapter.group, 'chat');
  const expected = [
    ...DIRECT_KEYS.sessions.filter((name) => !SESSION_CALLS_ELSEWHERE.includes(name)),
    ...CHAT_CALLS_BESIDES,
  ];
  assert.equal(expected.length, 39);
  for (const name of expected) assert.equal(typeof adapter.calls[name], 'function', name);
  assert.deepEqual(Object.keys(adapter.calls).sort(), [...expected].sort());
});
