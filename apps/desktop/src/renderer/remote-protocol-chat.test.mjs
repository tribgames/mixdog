// Replays the Chat calls recorded from Node b6f10295a (remote-protocol-chat.recorded.json, exact manifest) through the
// adapter over scripted `mixdogd` replies, and compares what the phone's readers receive.
// The scripted mixdogd reply of each case is the shape its Rust handler returns (file:line in `RUST`); the recording's
// inputs are the daemon replies Node's host was given.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createChatApi } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { normalizedProviderModels } from '../main/desktop-support.ts';
import { remoteToolOutput } from '../main/remote-transcript.ts';
import { ABORT_CASES as CASES } from './remote-protocol-chat-abort-cases.mjs';
import { verifiedRecordings } from './remote-protocol-chat-abort-fixture.mjs';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

const recorded = JSON.parse(readFileSync(new URL('./remote-protocol-chat.recorded.json', import.meta.url), 'utf8'));
// What a running mixdogd answered to the phone's own requests for the refusal cases (remote-protocol-chat-refusals.record.mjs).
const refusals = verifiedFixture('refusals').recordings[0];
const coreReply = (name) => {
  const { reply } = refusals.cases.find((x) => x.name === name);
  return reply.error
    ? Object.assign(new Error(reply.error.message), { detail: { kind: 'rpc', code: reply.error.code, reason: reply.error.data?.reason, message: reply.error.message, data: reply.error.data } })
    : reply.result;
};
const S = 'sess_a';
const threadRead = (state = {}) => ({
  thread: { id: S, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null },
  items: [],
  state,
  hasOlder: false,
});
const rpcError = (reason, message) => Object.assign(new Error(message), { detail: { kind: 'rpc', code: -32000, reason, message, data: { reason } } });

const PENDING_AP1 = { id: 'ap1', method: 'item/tool/requestApproval', params: { threadId: S, order: 1 } };
const startedTask = (n) => ({ 'thread/start': { thread: { id: n.result.sessionId }, turn: { kind: 'started', turnId: 't1' } }, state: n.result.snapshot });
const startedBlank = (n) => ({
  'thread/start': { thread: { id: 'sess_blank', cwd: n.result.cwd, projectPath: n.result.currentProject ?? undefined, classification: {} } },
});

/** Per case: the mixdogd replies (by protocol method), the readers' fields to compare, and a documented difference if any.
 *  RUST: where the reply shape comes from. */
const SCRIPT = {
  // thread_settings.rs:561 `Ok(Value::Bool(changed))`
  'markSessionRead-changed': (n) => ({ 'thread/readState/update': n.result }),
  'markSessionRead-unchanged': (n) => ({ 'thread/readState/update': n.result }),
  // mixdog-workspace/src/service.rs:1001 `{ "path": … }`
  getTaskWorkspace: (n) => ({ 'project/taskWorkspace': { path: n.result } }),
  // What a running mixdogd answers a Stop of a thread that runs no turn: `turnNotActive` (remote-protocol-chat-refusals.recorded.json)
  'abortSession-idle': () => ({ 'turn/interrupt': coreReply('abortSession-idle') }),
  // actor.rs:3980 `{ "kind": "started" }`
  'submitToSession-accepted': () => ({ 'turn/start': { kind: 'started', turnId: 't1' } }),
  // approval_notification.rs `answer_approval`: `{accepted}` once the thread took the decision; a bare Allow reads the approval the
  // thread shows (the card of the pending request, or none once it settled).
  'resolveToolApproval-approved': () => ({ pending: [PENDING_AP1], state: { toolApproval: { id: 'ap1' } }, 'thread/approval/answer': { accepted: true } }),
  'resolveToolApproval-settled': () => ({ pending: [], state: { toolApproval: null } }),
  setFast: () => ({ 'fast/set': true, 'thread/read': threadRead({ route: { provider: 'p', model: 'm', fast: true } }) }),
  setModelRoute: () => ({ 'route/set': { provider: 'p2', model: 'm2' }, 'thread/read': threadRead({ route: { provider: 'p2', model: 'm2', fast: false } }) }),
  'stopShellJob-stopped': (n) => ({ 'thread/backgroundTerminals/terminate': n.daemon.configure.value }),
  'stopShellJob-failed': (n) => ({ 'thread/backgroundTerminals/terminate': n.daemon.configure.value }),
  'releaseShellJob-released': (n) => ({ 'thread/backgroundTerminals/release': n.daemon.configure.value }),
  'releaseShellJob-throws': () => ({ 'thread/backgroundTerminals/release': new Error('no hold') }),
  // route_setup.rs / thread_route_service.rs: a bare boolean; the lane then reads the thread's state
  'scheduleQuotaResume-true': (n) => ({ 'thread/quotaResume/schedule': n.daemon.configure.value, 'thread/read': threadRead() }),
  'cancelQuotaResume-false': (n) => ({ 'thread/quotaResume/cancel': n.daemon.configure.value, 'thread/read': threadRead() }),
  'continueSessionInModel-true': (n) => ({ 'thread/continueInModel': n.daemon.configure.value, 'thread/read': threadRead() }),
  // thread_search.rs:56 `Value::Array(out)`
  searchSessionContent: (n) => ({ 'thread/search': n.daemon.search }),
  'readTranscriptHistory-unsupported': () => ({}),
  // delete.rs:290 `{ "deleted": true }`; a missing thread is `threadNotFound`
  'deleteSession-present': () => ({ 'thread/delete': { deleted: true }, 'thread/unsubscribe': {} }),
  'getQuotaAutoResume-on': (n) => ({ entries: [{ section: 'config', key: 'quotaAutoResume', value: n.result }] }),
  'getQuotaAutoResume-off': (n) => ({ entries: [{ section: 'config', key: 'quotaAutoResume', value: n.result }] }),
  // config/service.rs:95 ConfigWriteResponse
  'setQuotaAutoResume-off': () => ({ 'config/value/write': {} }),
  'renameSession-ok': () => ({ 'thread/name/set': {} }),
  // actor.rs:4276 refuses with the text Node's host threw
  'renameSession-refused': (n) => ({ 'thread/name/set': new Error(n.error) }),
  'renameSession-empty': () => ({}),
  'setSessionFavorite': () => ({ 'thread/metadata/update': {} }),
  startTask: (n) => ({ 'thread/start': { thread: { id: 'sess_new', cwd: n.result.cwd, classification: {}, projectPath: undefined } } }),
  // model_list.rs: the catalog rows are Node's (id, name), not yet the phone's DesktopModelOption
  listProviderModels: (n) => ({ 'model/list': n.daemon.read.value }),
  // initialize.connection.device (v1.rs:131): the name the phone's client announced
  'viewerDevice-named': (n) => ({ device: n.result }),
  'viewerDevice-default': () => ({ device: '' }),
  // reads.rs:208 `{ items }` is not used: the rows come from the thread fold the phone already holds
  'readTranscriptItem-found': (n) => ({ state: { items: n.daemon.read.full.items } }),
  'readTranscriptItem-not-viewed': () => ({ state: undefined }),
  'readTranscriptItem-not-held': (n) => ({ state: { items: n.daemon.read.full.items } }),
  // call.rs:76: `approval/provideSecret` answers `EmptyResult`
  'provideSecretInput-true': () => ({ 'approval/provideSecret': {} }),
  readCapabilities: () => ({ 'thread/start': { thread: { id: 'ctl' } }, 'config/getProfile': { name: 'Mixy' } }),
  'readCapabilities-failed': () => ({ 'thread/start': { thread: { id: 'ctl' } }, 'config/getProfile': new Error('profile unavailable') }),
  'prefetchSession-limit': () => ({}),
  'prefetchSession-fails': () => ({ resume: new Error('read failed') }),
  'setSessionArchived-true': () => ({ 'thread/archive': {} }),
  'setSessionArchived-false': () => ({ 'thread/unarchive': {} }),
  // v2/thread.rs:248 ThreadStartResponse { thread, turn? }; the thread is then folded by the client
  'submitNewTask-accepted': (n) => startedTask(n),
  'submitNewTask-route': (n) => startedTask(n),
  // handle.rs:527 `{ thread, messages, provider, model }`
  inheritSession: (n) => ({
    'thread/fork': { thread: { id: n.result.sessionId }, messages: 3, provider: 'p', model: 'm' },
    state: n.result.snapshot,
  }),
  startProject: (n) => startedBlank(n),
  'startProjectTask-registered': (n) => startedBlank(n),
  // home_api.rs:413 / :427
  'openAgentHome-new': (n) => ({ 'agent/home/open': n.result }),
  'openAgentHome-existing': (n) => ({ 'agent/home/open': n.result }),
  resetAgentHome: (n) => ({ 'agent/home/reset': n.result }),
  // rooms/service.rs:207 `{ sessionId, roomId }`; :268 `{}` for remove
  'agentRoomAction-create': (n) => ({ 'room/create': n.result }),
  'agentRoomAction-update': (n) => ({ 'room/update': n.result }),
  'agentRoomAction-remove': () => ({ 'room/remove': {} }),
  // feedback.rs:287 `{ id, status: "accepted" }`; the refusals are the core's own sentences
  'submitFeedback-accepted': (n) => ({ 'feedback/upload': n.result }),
  'submitFeedback-rate-limited': (n) => ({ 'feedback/upload': new Error(n.error) }),
  'submitFeedback-unavailable': (n) => ({ 'feedback/upload': new Error(n.error) }),
  'submitFeedback-bad-receipt': (n) => ({ 'feedback/upload': new Error(n.error) }),
  'submitFeedback-network': (n) => ({ 'feedback/upload': new Error(n.error) }),
  'deleteSession-missing': () => ({ 'thread/delete': rpcError('threadNotFound', 'thread not found'), 'thread/unsubscribe': {} }),
};

/** The cases this file does not replay through the base adapter, each with where it is replayed whole against Node's own answer:
 *  the test that owns it (remote-chat-host.test.mjs: the host adapter, which the phone mounts, answers these
 *  from the start/secret/room/home recordings and the core replies in remote-protocol-chat-refusals.recorded.json). */
const REPLAYED_BY = {
  startTask: 'remote-chat-host.test.mjs: "start" group, the whole blank snapshot against Node',
  startProject: 'remote-chat-host.test.mjs: "start" group, the whole blank snapshot against Node',
  'startProjectTask-registered': 'remote-chat-host.test.mjs: "start" group, the whole blank snapshot against Node',
  'provideSecretInput-false': 'remote-chat-host.test.mjs: provideSecretInput of an id that is no secret request',
  'startProjectTask-unknown': 'remote-chat-host.test.mjs: startProjectTask of an unregistered Project, over the core reply recorded from mixdogd',
  'openAgentHome-unknown-agent': 'remote-chat-host.test.mjs: openAgentHome of an unknown agent, over the core reply recorded from mixdogd',
  'agentRoomAction-unknown': 'remote-chat-host.test.mjs: agentRoomAction of an unknown action',
};

/** The fields the phone's readers use (use-composer-submission.ts:461, model-controls.tsx:654/754, shell-job-controls.tsx:63/65). */
const pick = (name, value) => {
  if (name.startsWith('submitNewTask')) return { accepted: value.accepted, sessionId: value.sessionId, snapshotSessionId: value.snapshot?.sessionId ?? null };
  if (name === 'inheritSession') return { sessionId: value.sessionId, snapshotSessionId: value.snapshot?.sessionId ?? null };
  if (name === 'agentRoomAction-update') return { name: value.name, members: value.members };
  if (name.startsWith('start')) {
    // remoteEnabled/remoteSessionId: snapshotWithRemoteSession fields of the host relay (reported gap)
    const { remoteEnabled: _a, remoteSessionId: _b, ...rest } = value;
    return rest;
  }
  if (name === 'setFast' || name === 'setModelRoute') return { provider: value.provider, model: value.model, fast: value.fast };
  return value;
};

function adapterFor(script) {
  const sent = [];
  const protocol = {
    call: async (method, params) => {
      sent.push({ method, params });
      if (!Object.hasOwn(script, method)) throw new Error(`unscripted request ${method}`);
      const reply = script[method];
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
  const api = createChatApi(
    client,
    {
      routeService,
      lane,
      coreErrorForWindow,
      normalizedProviderModels,
      sessionStateOf: () => script.state,
      whenFolded: (_threadId, resume) => resume().then(() => undefined),
      whenSettled: async () => undefined,
      remoteToolOutput,
    }
  );
  return { api, sent };
}

const invoke = {
  markSessionRead: (api, a) => api.markSessionRead(...a),
  getTaskWorkspace: (api) => api.getTaskWorkspace(),
  abortSession: (api, a) => api.abortSession(...a),
  submitToSession: (api, a) => api.submitToSession(...a),
  resolveToolApprovalForSession: (api, a) => api.resolveToolApprovalForSession(...a),
  setFast: (api, a) => api.setFast(...a),
  setModelRoute: (api, a) => api.setModelRoute(...a),
  stopShellJob: (api, a) => api.stopShellJob(...a),
  releaseShellJob: (api, a) => api.releaseShellJob(...a),
  scheduleQuotaResume: (api, a) => api.scheduleQuotaResume(...a),
  cancelQuotaResume: (api, a) => api.cancelQuotaResume(...a),
  continueSessionInModel: (api, a) => api.continueSessionInModel(...a),
  searchSessionContent: (api, a) => api.searchSessionContent(...a),
  readTranscriptHistory: (api, a) => api.readTranscriptHistory(...a),
  deleteSession: (api, a) => api.deleteSession(...a),
  getQuotaAutoResume: (api) => api.getQuotaAutoResume(),
  setQuotaAutoResume: (api, a) => api.setQuotaAutoResume(...a),
  renameSession: (api, a) => api.renameSession(...a),
  setSessionFavorite: (api, a) => api.setSessionFavorite(...a),
  startTask: (api) => api.startTask(),
  listProviderModels: (api, a) => api.listProviderModels(...a),
  viewerDevice: (api) => api.viewerDevice(),
  readTranscriptItem: (api, a) => api.readTranscriptItem(...a),
  answerApprovalNotification: (api, a) => api.answerApprovalNotification(...a),
  provideSecretInput: (api, a) => api.provideSecretInput(...a),
  readCapabilities: (api, a) => api.readCapabilities(...a),
  prefetchSession: (api, a) => api.prefetchSession(...a),
  setSessionArchived: (api, a) => api.setSessionArchived(...a),
  submitNewTask: (api, a) => api.submitNewTask(...a),
  inheritSession: (api, a) => api.inheritSession(...a),
  startProject: (api, a) => api.startProject(...a),
  startProjectTask: (api, a) => api.startProjectTask(...a),
  openAgentHome: (api, a) => api.openAgentHome(...a),
  resetAgentHome: (api, a) => api.resetAgentHome(...a),
  agentRoomAction: (api, a) => api.agentRoomAction(...a),
  submitFeedback: (api, a) => api.submitFeedback(...a),
};

test('the recording is an exact Node b6f10295a manifest', () => {
  assert.equal(recorded.manifest.exact, true);
  assert.equal(recorded.manifest.commit, 'b6f10295a2f698afc85332467192de28500bd146');
  assert.match(recorded.manifest.tree, /^[0-9a-f]{40}$/);
});

// A1: a notification's Allow / Deny, replayed through the production adapter against Node's answers (the `notify-` cases of the
// installed Stop recordings, Node's real push notifier over a real daemon). The thread shows the approval Node's host showed when the
// phone answered; the core's pending request is that approval's.
const abortRecording = verifiedRecordings().recordings[0];
for (const c of CASES.filter((x) => x.notify)) {
  test(`${c.name}: a notification's answers are Node's`, async () => {
    const { node } = abortRecording.cases.find((x) => x.name === c.name);
    const firstAnswer = node.hostStream.findIndex((e) => e.kind === 'reply' && e.method === 'answerApprovalNotification');
    const shown = node.hostStream.slice(0, firstAnswer).findLast((e) => e.kind === 'state').snapshot.toolApproval;
    const method = shown.kind === 'question' ? 'item/tool/requestUserInput' : 'item/tool/requestApproval';
    const script = { state: { toolApproval: shown }, pending: [{ id: String(shown.id), method, params: { threadId: S, order: 1 } }] };
    const { api } = adapterFor(script);
    const answers = [];
    for (const step of c.notify) answers.push(await api.answerApprovalNotification(S, step.id === 'shown' ? String(shown.id) : step.id, step.action));
    assert.deepEqual(answers, node.answers);
  });
}

for (const c of recorded.cases) {
  test(`${c.name}: the phone receives what Node returned`, async () => {
    if (REPLAYED_BY[c.name]) return; // replayed whole by the test the table names
    const script = SCRIPT[c.name]({ ...c.node, daemon: c.daemon });
    const { api, sent } = adapterFor(script);
    // "shell-job" and approval calls address the thread by id; the recorded args are the phone's own.
    if (c.node.error !== undefined) {
      await assert.rejects(invoke[c.call](api, c.args), (error) => error.message === c.node.error);
      return;
    }
    const reply = await invoke[c.call](api, c.args);
    assert.deepEqual(pick(c.name, reply), pick(c.name, c.node.result));
    if (c.name === 'prefetchSession-limit') assert.deepEqual(sent.find((s) => s.resume), { resume: S, window: { lastItems: 40 } });
    if (c.call === 'resolveToolApprovalForSession' && c.node.result === true) {
      assert.deepEqual(sent.find((s) => s.method === 'thread/approval/answer'), {
        method: 'thread/approval/answer',
        params: { threadId: S, approvalId: 'ap1', result: { approved: true } },
      });
    }
  });
}
