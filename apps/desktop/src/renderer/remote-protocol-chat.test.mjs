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

const recorded = JSON.parse(readFileSync(new URL('./remote-protocol-chat.recorded.json', import.meta.url), 'utf8'));
const S = 'sess_a';
const threadRead = (state = {}) => ({
  thread: { id: S, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null },
  items: [],
  state,
  hasOlder: false,
});
const rpcError = (reason, message) => Object.assign(new Error(message), { detail: { kind: 'rpc', code: -32000, reason, message, data: { reason } } });

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
  'resolveToolApproval-approved': () => ({ pending: [{ id: 'ap1', method: 'item/tool/requestApproval', params: { threadId: S, order: 1 } }] }),
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
  'deleteSession-missing': () => ({ 'thread/delete': rpcError('threadNotFound', 'thread not found'), 'thread/unsubscribe': {} }),
};

/** Differences that are the Rust gaps of the report: Node's answer and the adapter's, both asserted. */
const DIFFERENT = {
  // control.rs:366, actor.rs:2619: `turn/interrupt` hands no prompt back and its reply carries no `aborted` outcome
  'abortSession-restored': { aborted: true, restoreText: '', restoredSubmissionIds: [] },
  'abortSession-idle': { aborted: true, restoreText: '', restoredSubmissionIds: [] },
  // v2/thread.rs:741 + actor.rs:3980: a start while a turn runs is queued, never refused
  'submitToSession-refused': 'no mixdogd equivalent: turn/start queues',
};

/** The fields the phone's readers use (use-composer-submission.ts:461, model-controls.tsx:654/754, shell-job-controls.tsx:63/65). */
const pick = (name, value) => {
  if (name === 'startTask') {
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
    resumeThread: async () => ({}),
    unsubscribeThread: async (threadId) => protocol.call('thread/unsubscribe', { threadId }),
    server: { connection: { device: 'Phone' } },
  };
  const api = createChatApi(client, {
    routeService,
    lane,
    coreErrorForWindow,
    normalizedProviderModels,
    sessionStateOf: () => undefined,
    remoteToolOutput: () => null,
  });
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
    if (c.call === 'resolveToolApprovalForSession' && c.node.result === true) {
      assert.deepEqual(sent.find((s) => s.respond), { respond: 'ap1', answer: { result: { approved: true } } });
    }
  });
}
