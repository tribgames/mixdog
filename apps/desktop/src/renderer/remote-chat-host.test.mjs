// Exercises the replies a paired phone receives through the host
// adapter over scripted `mixdogd` replies, and compares the whole answer: the blank snapshots of the start calls, the remote fields,
// transcript pages, the stale-view refusal and the refusal texts. The scripted reply of each case is the shape its Rust handler
// returns (file:line in the comments); the recording's own inputs are the rows, registry and worktrees Node was given.
// Nothing is filtered: a case Node answers and mixdogd cannot is listed in UNMATCHED, with the reason.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { scopeClient } from '../../../mobile/src/phone-send-scope.ts';
import { createChatApi, foldTranscript } from './remote-protocol-chat.ts';
import { createChatHostApi } from './remote-chat-host.ts';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';
import {
  historyPages,
  phoneSession as S,
  remoteStates,
  secretInput,
  secretRequest,
  staleViews,
  starts,
} from './test-support/phone-chat-host-cases.mjs';

const rpcError = (reason, extra = {}) =>
  Object.assign(new Error(reason), {
    detail: { kind: 'rpc', code: -32000, reason, message: reason, data: { reason, ...extra } },
  });
const domainError = (code, message) => rpcError('domainError', { ...(code ? { code } : {}), message });

/** A Node transcript row as the item mixdogd holds it (the inverse of `rowOf` for the plain rows of these recordings). */
const itemOf = (row) =>
  row.kind === 'user'
    ? {
        type: 'userMessage',
        id: row.id,
        content: [{ type: 'text', text: row.text }],
        ...(row.device ? { device: row.device } : {}),
        meta: {},
      }
    : { type: 'agentMessage', id: row.id, text: row.text, meta: {} };
const foldRows = (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean));

/** The host adapter over a scripted core: `replies` by protocol method (an Error is thrown), `state` the thread the phone holds. */
function adapter({ replies = {}, state, remoteSession, device = 'Test phone' }) {
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
  const api = createChatHostApi(client, shared, createChatApi(client, shared, {}), {
    remoteSession: () => remoteSession,
  });
  return { api, sent, unclaimed };
}

for (const { call, args, method, params, reply, expected, touched } of starts) {
  test(`${call} resolves a folder and returns a blank snapshot without starting a thread`, async () => {
    const { api, sent } = adapter({ replies: { [method]: reply, 'project/touch': {} } });
    assert.deepEqual(await api[call](...args), expected);
    assert.deepEqual(sent, [
      { method, params },
      ...(touched ? [{ method: 'project/touch', params: { path: touched } }] : []),
    ]);
  });
}
test('a failed project lookup does not touch the registry or create a thread', async () => {
  const path = '/phone/missing';
  for (const [method, call, error, expected] of [
    [
      'project/create',
      'startProject',
      domainError('pathMissing', path),
      { name: 'Error', code: 'ENOENT', message: `ENOENT: no such file or directory, realpath '${path}'` },
    ],
    [
      'project/create',
      'startProject',
      domainError('notADirectory', 'Session workspace is not a directory.'),
      { name: 'TypeError', message: 'Session workspace is not a directory.' },
    ],
    [
      'project/directory',
      'startProjectTask',
      rpcError('permissionDenied'),
      { name: 'Error', message: 'Project is not available.' },
    ],
  ]) {
    const { api, sent } = adapter({ replies: { [method]: error } });
    await assert.rejects(api[call](` ${path} `), expected);
    assert.deepEqual(sent, [
      {
        method,
        params: call === 'startProjectTask' ? { path, owner: true } : { path },
      },
    ]);
  }
  for (const path of [null, '   ']) {
    const { api, sent } = adapter({});
    assert.throws(() => api.startProject(path), {
      name: 'TypeError',
      message: path === null ? 'projectPath must be a string.' : 'projectPath is invalid.',
    });
    assert.deepEqual(sent, []);
  }
});

for (const { name, state, expected } of remoteStates) {
  test(`${name}: remoteEnabled and remoteSessionId`, async () => {
    const { api } = adapter({ replies: { 'project/taskWorkspace': { path: expected.cwd } }, remoteSession: state });
    assert.deepEqual(await api.startTask(), expected);
  });
}

// ── transcript paging: thread/items/list (reads.rs items_list) answers ThreadItems, ascending, with hasOlder/hasNewer ───────────
const requestedPage = (request) => ({
  threadId: S,
  cursor: { type: 'item', itemId: request.before ?? request.after },
  sortDirection: request.before === undefined ? 'asc' : 'desc',
  limit: request.limit,
  ...(request.byteBudget ? { byteBudget: request.byteBudget } : {}),
});
for (const { name, request, wire, expected } of historyPages) {
  test(`${name}: the phone gets the page and flags`, async () => {
    const replies = {
      'thread/items/list': wire ?? rpcError('cursorInvalidated', { threadId: S, historyRev: 1 }),
    };
    const { api, sent } = adapter({ replies, state: { items: [] } });
    assert.deepEqual(await api.readTranscriptHistory(S, request), expected);
    assert.deepEqual(
      sent.map((s) => [s.method, s.params]),
      [['thread/items/list', requestedPage(request)]]
    );
  });
}
test('a history request with an invalid cursor, limit, position or byte budget sends nothing', async () => {
  const { api, sent } = adapter({ state: { items: [] } });
  for (const request of [
    null,
    { limit: 1 },
    { before: '', limit: 1 },
    { before: 'a', after: 'b', limit: 1 },
    { before: 'a'.repeat(513), limit: 1 },
    { before: 'a', limit: 0 },
    { before: 'a', limit: 513 },
    { before: 'a', limit: 1.5 },
    { before: 'a', limit: 1, byteBudget: 0 },
    { before: 'a', limit: 1, position: {} },
  ]) {
    await assert.rejects(api.readTranscriptHistory(S, request), {
      name: 'TypeError',
      message: 'transcript history request is invalid.',
    });
  }
  assert.deepEqual(sent, []);
});
test('a session this connection does not hold is not paged (READ_NOT_VIEWED)', async () => {
  const { api, sent } = adapter({});
  await assert.rejects(api.readTranscriptHistory(S, { before: 'r2', limit: 5 }), {
    message: 'This session is not open on this device.',
  });
  assert.deepEqual(sent, []);
});

test('history returns exact positions and uses a saved position instead of a repeated display id', async () => {
  const rows = [
    {
      ...itemOf({ kind: 'assistant', id: 'repeat', text: 'first' }),
      meta: { ext: { historyPosition: 'h1:0:stored-a' } },
    },
    {
      ...itemOf({ kind: 'assistant', id: 'repeat', text: 'second' }),
      meta: { ext: { historyPosition: 'h1:0:stored-b' } },
    },
  ];
  const { api, sent } = adapter({
    state: { items: [] },
    replies: { 'thread/items/list': { data: rows, hasOlder: true } },
  });
  const page = await api.readTranscriptHistory(S, { before: 'last', limit: 2 });
  assert.deepEqual(
    page.items.map(({ id, text }) => [id, text]),
    [
      ['repeat', 'first'],
      ['repeat', 'second'],
    ]
  );
  assert.deepEqual(page.positions, ['h1:0:stored-a', 'h1:0:stored-b']);
  await api.readTranscriptHistory(S, { before: 'repeat', position: page.positions[1], limit: 2 });
  assert.equal(sent.at(-1).params.cursor, 'h1:0:stored-b');
});

// ── the stale-view refusal ────────────────────────────────────────────────────────────────────────────────────────────────────
for (const { name, held, latest, stale } of staleViews) {
  test(`stale view: ${name}`, async () => {
    const replies = {
      'thread/items/list': { data: (latest ?? []).map(itemOf), hasOlder: false, hasNewer: false },
      'turn/start': { kind: 'started', turnId: 't1' },
    };
    const { api, sent } = adapter({ replies, state: held ? { items: held } : undefined });
    const submitted = api.submitToSession(S, 'Send from this phone');
    if (stale) {
      await assert.rejects(submitted, {
        name: 'Error',
        message: 'This conversation changed on another device. Review the latest messages, then send again.',
      });
      assert.equal(
        sent.some((s) => s.method === 'turn/start'),
        false,
        'a refused send does not start a turn'
      );
    } else {
      assert.equal(await submitted, true);
      assert.equal(
        sent.some((s) => s.method === 'turn/start'),
        true
      );
    }
    // `sessionStates.refresh`: the stale connection is sent the current transcript.
    assert.equal(sent.filter((s) => s.resume).length, stale ? 1 : 0);
  });
}

// ── refusal texts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('only a valid, filled secret request is sent, with its trimmed id', async () => {
  const { api, sent } = adapter({ replies: { 'approval/provideSecret': {} } });
  await assert.rejects(api.provideSecretInput('', secretInput), {
    name: 'TypeError',
    message: 'secret request id is invalid.',
  });
  await assert.rejects(api.provideSecretInput(null, secretInput), {
    name: 'TypeError',
    message: 'secret request id must be a string.',
  });
  assert.equal(await api.provideSecretInput('not-a-request', secretInput), false);
  assert.equal(await api.provideSecretInput(secretRequest, ''), false);
  assert.equal(await api.provideSecretInput(secretRequest, null), false);
  assert.deepEqual(sent, []);
  assert.equal(await api.provideSecretInput(` ${secretRequest} `, secretInput), true);
  assert.deepEqual(sent, [
    { method: 'approval/provideSecret', params: { requestId: secretRequest, secret: secretInput } },
  ]);
});
test('an invalid or unknown room action refuses locally', async () => {
  const { api, sent } = adapter({});
  await assert.rejects(api.agentRoomAction(null, []), { name: 'TypeError', message: 'action must be a string.' });
  await assert.rejects(api.agentRoomAction(' ', []), { name: 'TypeError', message: 'action is invalid.' });
  await assert.rejects(api.agentRoomAction('unknown', []), {
    name: 'TypeError',
    message: 'Unknown room action "unknown".',
  });
  assert.deepEqual(sent, []);
});
test('opening or resetting an unavailable agent home preserves the refusal and the requested agent id', async () => {
  for (const [call, method] of [
    ['openAgentHome', 'agent/home/open'],
    ['resetAgentHome', 'agent/home/reset'],
  ]) {
    const message = 'Agent "missing-agent" is not available.';
    const { api, sent } = adapter({ replies: { [method]: domainError(undefined, message) } });
    await assert.rejects(api[call](' missing-agent '), { message });
    assert.deepEqual(sent, [{ method, params: { agentId: 'missing-agent' } }]);
  }
});

// ── a prompt Node's intake refuses answers false ──────────────────────────────────────────────────────────────────────────────
// roster.recorded.json `refusals`: Node's real host (session-host.ts) asked, on a real session, to submit a blank prompt (submission.mjs:14-15).
// The phone's answer is the same and nothing is sent: the core takes a blank prompt and starts an empty turn.
const nodeRefusals = verifiedFixture('roster').recordings[0].refusals;
for (const [name, node] of Object.entries(nodeRefusals)) {
  test(`${name}: Node's refusal, and nothing reaches the core`, async () => {
    const call = name.slice(0, name.indexOf(' '));
    const prompt = JSON.parse(name.slice(call.length + 1));
    const { api, sent } = adapter({});
    const got =
      call === 'submitToSession'
        ? await api.submitToSession(S, prompt, { id: 'blank' })
        : await api.submitNewTask(prompt, { id: 'blank' }, {});
    assert.deepEqual(got, node);
    assert.deepEqual(sent, []);
  });
}
test('a failure of a real send still throws', async () => {
  const { api } = adapter({ replies: { 'turn/start': domainError('OTHER', 'boom') } });
  await assert.rejects(api.submitToSession(S, 'hi', {}), { message: 'boom' });
});

// ── PH-1: every request this module writes carries the call's transmission claim ───────────────────────────────────────────────
test("every request a host call writes is handed the call's claim", async () => {
  const { held, latest } = staleViews.find((row) => row.stale);
  const replies = {
    'project/taskWorkspace': { path: '/phone/root/task' },
    'thread/items/list': { data: (latest ?? []).map(itemOf), hasOlder: false, hasNewer: false },
    'approval/provideSecret': {},
    'turn/start': { kind: 'started', turnId: 't1' },
  };
  const { api, sent, unclaimed } = adapter({ replies, state: { items: held } });
  await api.startTask();
  await api.readTranscriptHistory(S, { before: 'r2', limit: 5 });
  await assert.rejects(api.submitToSession(S, 'A prompt with a stale view'), /conversation changed/);
  await api.provideSecretInput(secretRequest, secretInput);
  const resumed = sent.filter((s) => s.resume).length;
  assert.ok(resumed > 0 && sent.length > 4, 'the stale refusal resumed the thread, and each call wrote');
  assert.deepEqual(unclaimed, []);
});

test('the desktop history page keeps a tool output whole; the phone page caps it', async () => {
  const output = 'line of output\n'.repeat(2000);
  const wire = {
    data: [
      {
        type: 'toolCall',
        id: 'big',
        name: 'bash',
        input: { command: 'ls' },
        output,
        meta: { status: 'completed', at: 1 },
      },
    ],
    hasOlder: false,
    hasNewer: false,
  };
  const outputOf = (page) => JSON.stringify(page.items[0]);
  const { api } = adapter({ replies: { 'thread/items/list': wire }, state: { items: [] } });
  const desktop = await api.readTranscriptHistory(S, { before: 'anchor', limit: 2 }, true);
  const phone = await api.readTranscriptHistory(S, { before: 'anchor', limit: 2 });
  assert.ok(outputOf(desktop).includes(output.trimEnd().replaceAll('\n', '\\n')));
  assert.ok(!outputOf(phone).includes(output.trimEnd().replaceAll('\n', '\\n')));
});
