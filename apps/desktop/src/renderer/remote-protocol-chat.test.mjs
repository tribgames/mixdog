// The base chat API (createChatApi, which the host adapter wraps: its blank-input check is remote-chat-host-calls.test.mjs) over what a
// running mixdogd said (remote-protocol-chat-refusals.core: the core's own refusal replies), a retried start of an already accepted task,
// and the requests two calls write. Every expected outcome below is written here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatApi, foldTranscript } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { normalizedProviderModels } from '../main/desktop-support.ts';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

const refusals = verifiedFixture('refusals').recordings[0];
const recordedCase = (name) => refusals.cases.find((x) => x.name === name);
/** What the core answered the phone's request: the error as the client throws it, or the result. */
const coreReply = (name) => {
  const { reply } = recordedCase(name);
  return reply.error
    ? Object.assign(new Error(reply.error.message), {
        detail: {
          kind: 'rpc',
          code: reply.error.code,
          reason: reply.error.data?.reason,
          message: reply.error.message,
          data: reply.error.data,
        },
      })
    : reply.result;
};
const SESSION = 'sess_a';
function adapterFor(script) {
  const sent = [];
  const protocol = {
    call: async (method, params) => {
      sent.push({ method, params });
      if (!Object.hasOwn(script, method)) throw new Error(`unscripted request ${method}`);
      const reply = typeof script[method] === 'function' ? script[method](params) : script[method];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    snapshot: () => ({ entries: script.entries ?? [] }),
    noteUserInput() {},
    // An answered request is no longer pending (the core resolved it).
    respond: (id, answer) => {
      sent.push({ respond: id, answer });
      if (Array.isArray(script.pending)) script.pending = script.pending.filter((p) => p.id !== id);
    },
    pendingServerRequests: () => script.pending ?? [],
  };
  const lane = createCapabilityLane({ protocol });
  const client = {
    call: protocol.call,
    resumeThread: async (threadId, window) => {
      sent.push({ resume: threadId, window });
      if (script.resume instanceof Error) throw script.resume;
      return {};
    },
    unsubscribeThread: async (threadId) => protocol.call('thread/unsubscribe', { threadId }),
    server: { connection: { device: script.device } },
  };
  const api = createChatApi(client, {
    routeService,
    lane,
    coreErrorForWindow,
    normalizedProviderModels,
    sessionStateOf: () => script.state,
    whenFolded: (_threadId, resume) => resume().then(() => undefined),
    whenSettled: async () => undefined,
    approvalRequestId: (cardId) => cardId,
    transcript: foldTranscript(client),
  });
  return { api, sent };
}

test('base API: a Stop of a thread that runs no turn answers that nothing was aborted and restores nothing', async () => {
  const { api, sent } = adapterFor({ 'turn/interrupt': coreReply('abortSession-idle') });
  const answer = await api.abortSession(SESSION, {});
  assert.equal(answer.aborted, false);
  assert.equal(answer.restoreText, '');
  assert.deepEqual(answer.restoredSubmissionIds, []);
  assert.deepEqual(sent, [{ method: 'turn/interrupt', params: { threadId: SESSION } }]);
});

for (const [name, prompt, id] of [
  ['submitToSession-empty', '', 'refusals-empty'],
  ['submitToSession-blank', '   ', 'refusals-blank'],
]) {
  test(`${name}: the core's refusal of a ${prompt ? 'blank' : 'empty'} prompt is the message the base API rejects with`, async () => {
    const { api, sent } = adapterFor({ 'turn/start': coreReply(name) });
    await assert.rejects(api.submitToSession(SESSION, prompt, { id }), { message: 'prompt is invalid.' });
    assert.deepEqual(sent, [
      {
        method: 'turn/start',
        params: { threadId: SESSION, input: { prompt, options: { clientSubmissionId: id } } },
      },
    ]);
  });
}

test("base API / submitNewTask-empty: the core's refusal of an empty first prompt is the message the base API rejects with, after one start request", async () => {
  const { api, sent } = adapterFor({ 'thread/start': coreReply('submitNewTask-empty') });
  await assert.rejects(api.submitNewTask('', { id: 'refusals-new-empty' }, {}), { message: 'prompt is invalid.' });
  assert.deepEqual(sent, [
    {
      method: 'thread/start',
      params: {
        kind: 'task',
        draft: {},
        initialInput: { prompt: '', options: { clientSubmissionId: 'refusals-new-empty' } },
      },
    },
  ]);
});

test('base API / submitNewTask: a retry of an already accepted task (a reply without a turn) is accepted with its session and snapshot', async () => {
  const snapshot = { sessionId: 'sess_new' };
  const { api } = adapterFor({ 'thread/start': { thread: { id: 'sess_new' } }, state: snapshot });
  const reply = await api.submitNewTask('hello', { id: 'retry-1' }, {});
  assert.equal(reply.accepted, true);
  assert.equal(reply.sessionId, 'sess_new');
  assert.equal(reply.snapshot?.sessionId, 'sess_new');
});

test('prefetchSession of a thread the phone does not follow resumes it with the requested window of the last 40 items', async () => {
  const { api, sent } = adapterFor({});
  assert.equal(await api.prefetchSession(SESSION, 40, 'trace1'), true);
  assert.deepEqual(
    sent.find((entry) => entry.resume),
    { resume: SESSION, window: { lastItems: 40 } }
  );
});

test('an Allow of the approval the thread shows answers the core with that approval and an approved result', async () => {
  const { api, sent } = adapterFor({
    pending: [{ id: 'ap1', method: 'item/tool/requestApproval', params: { threadId: SESSION, order: 1 } }],
    state: { toolApproval: { id: 'ap1' } },
    'thread/approval/answer': { accepted: true },
  });
  assert.equal(await api.resolveToolApprovalForSession(SESSION, 'ap1', { approved: true }), true);
  assert.deepEqual(
    sent.find((entry) => entry.method === 'thread/approval/answer'),
    { method: 'thread/approval/answer', params: { threadId: SESSION, approvalId: 'ap1', result: { approved: true } } }
  );
});