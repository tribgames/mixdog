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

const recorded = JSON.parse(readFileSync(new URL('./remote-protocol-chat.recorded.json', import.meta.url), 'utf8'));
const S = 'sess_a';
const threadRead = (state = {}) => ({
  thread: { id: S, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null },
  items: [],
  state,
  hasOlder: false,
});
const rpcError = (reason, message) => Object.assign(new Error(message), { detail: { kind: 'rpc', code: -32000, reason, message, data: { reason } } });

// The stand-in the recorder gave `approvalNotifications` (push-notifier.ts rules are not under test).
const NOTIFICATIONS = {
  approvalAllowDecision: (_s, id) => (id === 'ap1' ? { approved: true, scope: 'once' } : undefined),
  approvalPointerOnly: (_s, id) => id === 'ptr',
};
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
  // v2/thread.rs:741 TurnInterruptResponse: `cancelRequested` is always true (R12)
  'abortSession-restored': () => ({ 'turn/interrupt': { cancelRequested: true } }),
  'abortSession-idle': () => ({ 'turn/interrupt': { cancelRequested: true } }),
  // actor.rs:3980 `{ "kind": "started" }`
  'submitToSession-accepted': () => ({ 'turn/start': { kind: 'started', turnId: 't1' } }),
  // approval_notification.rs `answer_approval`: `{accepted}` once the thread took the decision
  'resolveToolApproval-approved': () => ({
    pending: [{ id: 'ap1', method: 'item/tool/requestApproval', params: { threadId: S, order: 1 } }],
    'thread/approval/answer': { accepted: true },
  }),
  'resolveToolApproval-settled': () => ({ pending: [] }),
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
  'answerApprovalNotification-answered': () => ({ notifications: NOTIFICATIONS, pending: [PENDING_AP1], 'thread/approval/answer': { accepted: true } }),
  'answerApprovalNotification-settled': () => ({ notifications: NOTIFICATIONS, pending: [] }),
  'answerApprovalNotification-open': () => ({ notifications: NOTIFICATIONS, pending: [] }),
  'resolveToolApproval-pointer-only': () => ({ notifications: NOTIFICATIONS, pending: [PENDING_AP1] }),
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

/** Differences that are the Rust gaps of the report: Node's answer and the adapter's, both asserted. */
const DIFFERENT = {
  // The start calls create no thread (Node's blank snapshot): remote-protocol-chat-host.ts composes it, replayed in remote-protocol-chat-host.test.mjs.
  startTask: 'covered by remote-protocol-chat-host.test.mjs',
  startProject: 'covered by remote-protocol-chat-host.test.mjs',
  'startProjectTask-registered': 'covered by remote-protocol-chat-host.test.mjs',
  // control.rs:366, actor.rs:2619: `turn/interrupt` hands no prompt back and its reply carries no `aborted` outcome
  'abortSession-restored': { aborted: true, restoreText: '', restoredSubmissionIds: [] },
  'abortSession-idle': { aborted: true, restoreText: '', restoredSubmissionIds: [] },
  // v2/thread.rs:741 + actor.rs:3980: a start while a turn runs is queued, never refused
  'submitToSession-refused': 'no mixdogd equivalent: turn/start queues',
  'submitNewTask-refused': 'no mixdogd equivalent: thread/start with an initial input always answers its turn',
  // Node answered false from the window process's slot; the core's answer for an unknown request id is unread (call.rs:76)
  'provideSecretInput-false': 'unverified: the core refusal for an unknown request id is not read',
  'startProjectTask-unknown': 'unverified: the core refusal text for an unregistered project is not read',
  'openAgentHome-unknown-agent': 'unverified: the core refusal text for an unknown agent is not read',
  'agentRoomAction-unknown': 'the adapter refuses with routeService unknownMethod, not Node text: Unknown room action',
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
  if (name.startsWith('abortSession')) return { aborted: value.aborted, restoreText: value.restoreText, restoredSubmissionIds: value.restoredSubmissionIds };
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
    respond: (id, answer) => sent.push({ respond: id, answer }),
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
      remoteToolOutput,
    },
    { approvalNotifications: script.notifications }
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

for (const c of recorded.cases) {
  test(`${c.name}: the phone receives what Node returned`, async () => {
    const different = DIFFERENT[c.name];
    if (typeof different === 'string') return; // no mixdogd counterpart; listed in the report
    const script = SCRIPT[c.name]({ ...c.node, daemon: c.daemon });
    const { api, sent } = adapterFor(script);
    // "shell-job" and approval calls address the thread by id; the recorded args are the phone's own.
    if (c.node.error !== undefined) {
      await assert.rejects(invoke[c.call](api, c.args), (error) => error.message === c.node.error);
      return;
    }
    const reply = await invoke[c.call](api, c.args);
    if (different) {
      assert.notDeepEqual(pick(c.name, reply), pick(c.name, c.node.result));
      assert.deepEqual(pick(c.name, reply), different);
    } else {
      assert.deepEqual(pick(c.name, reply), pick(c.name, c.node.result));
    }
    if (c.name === 'prefetchSession-limit') assert.deepEqual(sent.find((s) => s.resume), { resume: S, window: { lastItems: 40 } });
    if (c.call === 'resolveToolApprovalForSession' && c.node.result === true) {
      assert.deepEqual(sent.find((s) => s.method === 'thread/approval/answer'), {
        method: 'thread/approval/answer',
        params: { threadId: S, approvalId: 'ap1', result: { approved: true } },
      });
    }
  });
}
