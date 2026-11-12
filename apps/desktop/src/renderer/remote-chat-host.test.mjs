// Replays what Node b6f10295a answered a paired phone (native/core/fixtures/phone-chat/host.json, exact manifest) through the host
// adapter over scripted `mixdogd` replies, and compares the whole answer: the blank snapshots of the start calls, the remote fields,
// transcript pages, the stale-view refusal and the refusal texts. The scripted reply of each case is the shape its Rust handler
// returns (file:line in the comments); the recording's own inputs are the rows, registry and worktrees Node was given.
// Nothing is filtered: a case Node answers and mixdogd cannot is listed in UNMATCHED, with the reason.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { scopeClient } from '../../../mobile/src/phone-send-scope.ts';
import { createChatApi, foldTranscript } from './remote-protocol-chat.ts';
import { createChatHostApi } from './remote-chat-host.ts';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recorded = read('../../../../native/core/fixtures/phone-chat/host.json');
const chat = read('./remote-protocol-chat.recorded.json');
const S = 'sess_a';
const ROOT = '/phone/root';
const at = (value) => (typeof value === 'string' ? value.replaceAll('<ROOT>', ROOT) : JSON.parse(JSON.stringify(value).replaceAll('<ROOT>', ROOT)));

const rpcError = (reason, extra = {}) =>
  Object.assign(new Error(reason), { detail: { kind: 'rpc', code: -32000, reason, message: reason, data: { reason, ...extra } } });
const domainError = (code, message) => rpcError('domainError', { ...(code ? { code } : {}), message });

/** A Node transcript row as the item mixdogd holds it (the inverse of `rowOf` for the plain rows of these recordings). */
const itemOf = (row) =>
  row.kind === 'user'
    ? { type: 'userMessage', id: row.id, content: [{ type: 'text', text: row.text }], ...(row.device ? { device: row.device } : {}), meta: {} }
    : { type: 'agentMessage', id: row.id, text: row.text, meta: {} };
const foldRows = (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean));

/** The host adapter over a scripted core: `replies` by protocol method (an Error is thrown), `state` the thread the phone holds. */
function adapter({ replies = {}, state, remoteSession, device = 'Pixel 9' }) {
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
  const api = createChatHostApi(client, shared, createChatApi(client, shared, {}), { remoteSession: () => remoteSession });
  return { api, sent, unclaimed };
}

const failure = (error) => ({ message: error.message, ...(error.name === 'TypeError' || error.name === 'Error' ? { name: error.name } : {}), ...(error.code ? { code: error.code } : {}) });
const outcome = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
};

test('the recordings are exact Node b6f10295a manifests', () => {
  for (const file of [recorded, chat]) {
    assert.equal(file.manifest.exact, true);
    assert.equal(file.manifest.commit, 'b6f10295a2f698afc85332467192de28500bd146');
    assert.match(file.manifest.tree, /^[0-9a-f]{40}$/);
  }
});

// The sections below each take one `group` of the recording; no recorded case may fall outside them.
test('every recorded case belongs to a replayed group', () => {
  const replayed = ['start', 'remote', 'history', 'history-request', 'stale', 'secret', 'room', 'home'];
  assert.deepEqual([...new Set(recorded.cases.map((c) => c.group))].sort(), [...replayed].sort());
});

// ── start calls ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// mixdog-workspace/src/service.rs: project/create answers { project }, project/directory and project/taskWorkspace { path };
// a failure is the domain error { code: pathMissing (message: the path realpath named) | notADirectory (message: Node's text) } or permissionDenied.
for (const c of recorded.cases.filter((x) => x.group === 'start')) {
  test(`${c.name}: the blank snapshot and errors are Node's`, async () => {
    const node = at(c.node);
    const trimmed = typeof c.args[0] === 'string' ? at(c.args[0]).trim() : undefined;
    const rejected = node.error;
    const missing = rejected?.code === 'ENOENT';
    const named = c.setup.worktrees && missing ? at(c.setup.projects[0].path) : trimmed;
    const failing = missing
      ? domainError('pathMissing', named)
      : rejected?.message === 'Session workspace is not a directory.'
        ? domainError('notADirectory', rejected.message)
        : rejected?.message === 'Project is not available.'
          ? rpcError('permissionDenied')
          : undefined;
    const folder = node.result?.cwd;
    const replies = {
      'project/taskWorkspace': { path: folder },
      'project/create': failing ?? { project: { path: folder } },
      'project/directory': failing ?? { path: folder },
      'project/touch': { project: {} },
    };
    const { api, sent } = adapter({ replies });
    const run = outcome(() => api[c.call](...c.args.map(at)));
    const got = await run;
    if (rejected) {
      assert.ok(got.error, `${c.name}: Node threw, the adapter returned`);
      assert.deepEqual(failure(got.error), { ...rejected, ...(rejected.code ? {} : {}) });
    } else {
      assert.deepEqual(got.result, node.result);
    }
    // The registry: Node marked a Project used exactly when the start went through.
    const touched = node.storeCalls.filter(([call]) => call === 'touchProjectSelected').map(([, path]) => path);
    assert.deepEqual(sent.filter((s) => s.method === 'project/touch').map((s) => s.params.path), c.call === 'startProject' ? touched : touched.length ? [trimmed] : []);
    // No thread is ever created.
    assert.deepEqual(sent.filter((s) => s.method?.startsWith('thread/')), []);
  });
}

// ── the remote fields: Node read them from the catalog's `remoteSession`; mixdogd's hostState key is { sessionId } ─────────────
for (const c of recorded.cases.filter((x) => x.group === 'remote')) {
  test(`${c.name}: remoteEnabled and remoteSessionId`, async () => {
    const remote = c.setup.remoteSession;
    const hostState = remote === null ? undefined : { sessionId: remote.enabled === true ? (remote.sessionId ?? null) : null };
    const { api } = adapter({ replies: { 'project/taskWorkspace': { path: c.node.result.cwd } }, remoteSession: hostState });
    assert.deepEqual(await api.startTask(), c.node.result);
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
// 'stored-unsupported-reader' is a Node daemon older than the phone (no historical-position reader) answering an empty page with `reset: true`. No core
// is without the reader, but the core answers the same page through cursorInvalidated (a cursor the thread no longer holds), which is what is replayed.
for (const c of recorded.cases.filter((x) => x.group === 'history')) {
  test(`${c.name}: the page and its flags are Node's`, async () => {
    // The phone's page is the wire answer without its sessionId (session-host-transport.ts readTranscriptHistory keeps items, flags, positions, reset).
    const { sessionId: _wire, ...answer } = c.node.result;
    const request = c.args[1];
    const replies = {
      'thread/items/list': answer.reset
        ? rpcError('cursorInvalidated', { threadId: S, historyRev: 1 })
        : { data: answer.items.map(itemOf), hasOlder: answer.hasOlder, hasNewer: answer.hasNewer },
    };
    const { api, sent } = adapter({ replies, state: { items: [] } });
    assert.deepEqual(await api.readTranscriptHistory(S, request), answer);
    assert.deepEqual(sent.map((s) => [s.method, s.params]), [['thread/items/list', requestedPage(request)]]);
    assert.equal(Object.hasOwn(await api.readTranscriptHistory(S, request), 'positions'), false);
  });
}
for (const c of recorded.cases.filter((x) => x.group === 'history-request')) {
  test(`history request ${c.name}: Node's check`, async () => {
    const replies = { 'thread/items/list': { data: [], hasOlder: false, hasNewer: false } };
    const { api, sent } = adapter({ replies, state: { items: [] } });
    const got = await outcome(() => api.readTranscriptHistory(...c.args));
    if (c.node.error) {
      assert.deepEqual(failure(got.error), c.node.error);
      assert.deepEqual(sent, []);
    } else {
      assert.deepEqual(got.result, c.node.result);
    }
  });
}
test('a session this connection does not hold is not paged (READ_NOT_VIEWED)', async () => {
  const { api, sent } = adapter({});
  await assert.rejects(api.readTranscriptHistory(S, { before: 'r2', limit: 5 }), { message: 'This session is not open on this device.' });
  assert.deepEqual(sent, []);
});

// ── the stale-view refusal ────────────────────────────────────────────────────────────────────────────────────────────────────
for (const c of recorded.cases.filter((x) => x.group === 'stale')) {
  test(`stale ${c.name}: the send is refused as Node refused it`, async () => {
    const { held, latest } = c.setup;
    const replies = { 'thread/items/list': { data: (latest ?? []).map(itemOf), hasOlder: false, hasNewer: false }, 'turn/start': { kind: 'started', turnId: 't1' } };
    const { api, sent } = adapter({ replies, state: held ? { items: held } : undefined });
    const got = await outcome(() => api.submitToSession(...c.args));
    const node = c.node.result;
    if (node.error) {
      assert.deepEqual(failure(got.error), node.error);
      assert.equal(sent.some((s) => s.method === 'turn/start'), false, 'a refused send reaches no core');
    } else {
      assert.equal(got.result, node.result);
      assert.equal(sent.some((s) => s.method === 'turn/start'), true);
    }
    // `sessionStates.refresh`: the stale connection is sent the current transcript.
    assert.equal(sent.filter((s) => s.resume).length, node.refreshed.length);
  });
}

// ── refusal texts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const c of recorded.cases.filter((x) => x.group === 'secret')) {
  test(`provideSecretInput ${c.name}`, async () => {
    const { api, sent } = adapter({ replies: { 'approval/provideSecret': {} } });
    const got = await outcome(() => api.provideSecretInput(...c.args));
    if (c.node.error) assert.deepEqual(failure(got.error), c.node.error);
    else assert.equal(got.result, c.node.result);
    // The value reaches the core only when Node took it.
    assert.equal(sent.length, c.node.result === true ? 1 : 0);
    if (c.node.result === true) assert.deepEqual(sent[0].params.requestId, c.args[0].trim());
  });
}
for (const c of recorded.cases.filter((x) => x.group === 'room')) {
  test(`agentRoomAction ${c.name}`, async () => {
    const { api, sent } = adapter({});
    const got = await outcome(() => api.agentRoomAction(...c.args));
    assert.deepEqual(failure(got.error), c.node.error);
    assert.deepEqual(sent, []);
  });
}
for (const c of recorded.cases.filter((x) => x.group === 'home')) {
  test(`${c.name}: Node's text`, async () => {
    // home_api.rs:300 / :288: the core's refusals carry Node's text as plain failures.
    const reply = domainError(undefined, c.node.error.message);
    const { api } = adapter({ replies: { 'agent/home/open': reply, 'agent/home/reset': reply } });
    const got = await outcome(() => api[c.call](...c.args));
    assert.equal(got.error.message, c.node.error.message);
  });
}

// ── a prompt Node's intake refuses answers false ──────────────────────────────────────────────────────────────────────────────
// roster.recorded.json `refusals`: Node's real host (session-host.ts) asked, on a real session, to submit a blank prompt (submission.mjs:14-15).
// The phone's answer is the same and nothing is sent: the core takes a blank prompt and starts an empty turn.
const nodeRefusals = verifiedFixture('roster').recordings[0].refusals;
for (const [name, node] of Object.entries(nodeRefusals)) {
  test(`${name}: Node's refusal, and nothing reaches the core`, async () => {
    const call = name.slice(0, name.indexOf(' '));
    const prompt = JSON.parse(name.slice(call.length + 1));
    const { api, sent } = adapter({});
    const got = call === 'submitToSession' ? await api.submitToSession(S, prompt, { id: 'blank' }) : await api.submitNewTask(prompt, { id: 'blank' }, {});
    assert.deepEqual(got, node);
    assert.deepEqual(sent, []);
  });
}
test('a failure of a real send still throws', async () => {
  const { api } = adapter({ replies: { 'turn/start': domainError('OTHER', 'boom') } });
  await assert.rejects(api.submitToSession(S, 'hi', {}), { message: 'boom' });
});

// ── the chat recording's cases this adapter answers (remote-protocol-chat.test.mjs lists them as owned here) ─────────────────────
// `refusals.recorded.json` holds what a running mixdogd answered to the phone's own requests for them (remote-protocol-chat-refusals.record.mjs).
const core = verifiedFixture('refusals').recordings[0];
const coreReply = (name) => {
  const { reply } = core.cases.find((x) => x.name === name);
  return reply.error
    ? Object.assign(new Error(reply.error.message), { detail: { kind: 'rpc', code: reply.error.code, reason: reply.error.data?.reason, message: reply.error.message, data: reply.error.data } })
    : reply.result;
};
const chatCase = (name) => chat.cases.find((c) => c.name === name);
test('startProjectTask of an unregistered Project: the core\'s refusal reads as Node\'s', async () => {
  const c = chatCase('startProjectTask-unknown');
  const { api, sent } = adapter({ replies: { 'project/directory': coreReply('startProjectTask-unknown') } });
  const got = await outcome(() => api.startProjectTask(...c.args));
  assert.equal(got.error.message, c.node.error);
  assert.equal(sent[0].method, core.cases.find((x) => x.name === 'startProjectTask-unknown').request.method);
});
test('openAgentHome of an unknown agent: the core\'s refusal reads as Node\'s', async () => {
  const c = chatCase('openAgentHome-unknown-agent');
  const { api, sent } = adapter({ replies: { 'agent/home/open': coreReply('openAgentHome-unknown-agent') } });
  const got = await outcome(() => api.openAgentHome(...c.args));
  assert.equal(got.error.message, c.node.error);
  assert.deepEqual(sent, [core.cases.find((x) => x.name === 'openAgentHome-unknown-agent').request].map(({ method, params }) => ({ method, params })));
});
test('agentRoomAction of an unknown action: Node\'s text, nothing sent', async () => {
  const c = chatCase('agentRoomAction-unknown');
  const { api, sent } = adapter({});
  const got = await outcome(() => api.agentRoomAction(...c.args));
  assert.equal(got.error.message, c.node.error);
  assert.deepEqual(sent, []);
});
test('provideSecretInput of an id that is no secret request: false, nothing sent', async () => {
  const c = chatCase('provideSecretInput-false');
  const { api, sent } = adapter({});
  assert.equal(await api.provideSecretInput(...c.args), c.node.result);
  assert.deepEqual(sent, []);
});
test('the three start calls are replayed whole above', () => {
  for (const name of ['startTask', 'startProject', 'startProjectTask-registered']) {
    const c = chatCase(name);
    assert.ok(recorded.cases.some((x) => x.group === 'start' && x.call === c.call), `${name}: no start case replays ${c.call}`);
  }
});
// ── PH-1: every request this module writes carries the call's transmission claim ───────────────────────────────────────────────
test('every request a host call writes is handed the call\'s claim', async () => {
  const stale = recorded.cases.find((x) => x.group === 'stale' && x.node.result.error);
  const { held, latest } = stale.setup;
  const replies = {
    'project/taskWorkspace': { path: '/phone/root/task' },
    'thread/items/list': { data: (latest ?? []).map(itemOf), hasOlder: false, hasNewer: false },
    'approval/provideSecret': {},
    'turn/start': { kind: 'started', turnId: 't1' },
  };
  const { api, sent, unclaimed } = adapter({ replies, state: { items: held } });
  await api.startTask();
  await api.readTranscriptHistory(S, { before: 'r2', limit: 5 });
  await outcome(() => api.submitToSession(...stale.args));
  await api.provideSecretInput(...recorded.cases.find((x) => x.group === 'secret' && x.node.result === true).args);
  const resumed = sent.filter((s) => s.resume).length;
  assert.ok(resumed > 0 && sent.length > 4, 'the stale refusal resumed the thread, and each call wrote');
  assert.deepEqual(unclaimed, []);
});
