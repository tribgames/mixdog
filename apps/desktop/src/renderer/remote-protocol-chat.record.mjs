// Records what Node's host (SessionHost at b6f10295a, run unchanged from an exact export) returns to the phone for the Chat
// calls, over a scripted daemon wire (`SessionClient`). The scripted daemon replies are the recording's inputs and are
// stored with each case; the host's reply and the daemon calls it made are Node's.
//
//   node --import tsx remote-protocol-chat.record.mjs <export dir> <out file>   (cwd: <export dir>/apps/desktop)
//
// The export dir is `git archive b6f10295a` of the whole tree; its manifest (commit, tree) is written to the output.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The shared exact export of b6f10295a (read-only): the recorder only imports from it.
const [exportDir, outFile] = process.argv.slice(2);
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
process.env.MIXDOG_DATA_DIR = await mkdtemp(join(tmpdir(), 'phone-chat-rec-'));
const { SessionHost } = await import(pathToFileURL(join(exportDir, 'apps/desktop/src/main/session-host.ts')).href);

const row = (id, extra = {}) => ({ id, owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 4, preview: id, ...extra });
const full = (sessionId, extra = {}) => ({
  sessionId,
  revision: 1,
  full: { sessionId, items: [], queued: [], busy: false, commandBusy: false, provider: 'p', model: 'm', fast: false, ...extra },
});

async function withHost(daemon, run, remoteConfig = {}) {
  const calls = [];
  const client = new Proxy(
    {},
    {
      get: (_t, name) => name === 'then' ? undefined : async (args = {}) => {
        if (name === 'close') return undefined;
        calls.push({ method: name, args: JSON.parse(JSON.stringify(args ?? null, (k, v) => (k === 'open' || k === 'baseRevision' ? undefined : v)) ?? 'null') });
        const reply = daemon[name];
        if (reply === undefined) throw new Error(`unscripted daemon call ${String(name)}`);
        return typeof reply === 'function' ? reply(args) : reply;
      },
    }
  );
  const registered = [...(daemon.projects ?? [])];
  const projectsStore = {
    listProjects: () => registered,
    addProject: (path) => {
      let entry = registered.find((p) => p.path === path);
      if (!entry) registered.push((entry = { name: path.split(/[\\\\/]/).pop(), path, addedAt: 1 }));
      return entry;
    },
    touchProjectSelected() {},
  };
  const root = await mkdtemp(join(tmpdir(), 'phone-chat-host-'));
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => client,
      loadProjects: async () => projectsStore,
      loadSessionStore: async () => ({ listProjects: async () => daemon.projects ?? [] }),
      loadSessionSearch: async () => ({ searchSessionMessages: async () => daemon.search ?? [] }),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  const events = [];
  const remoteCalls = [];
  const { createRemoteMethods } = await import(pathToFileURL(join(exportDir, 'apps/desktop/src/main/remote-methods.ts')).href);
  const remote = createRemoteMethods(
    {
      host,
      hostRequest: async (method, args) => {
        remoteCalls.push({ method, args });
        return remoteConfig.hostReply;
      },
      approvalNotifications: remoteConfig.approvalNotifications,
    },
    remoteConfig.client
  );
  host.subscribeSessions((s) => events.push({ event: 'sessions', ids: s.map((x) => x.id) }));
  host.subscribeSessionStates((u) => events.push({ event: 'sessionState', sessionId: u.sessionId, source: u.source }));
  try {
    const result = await run(host, remote);
    return { result, daemonCalls: calls, events, ...(remoteCalls.length ? { hostRequests: remoteCalls } : {}), ...(remoteConfig.client?.calls?.length ? { clientCalls: remoteConfig.client.calls } : {}) };
  } catch (error) {
    return { error: String(error?.message ?? error), daemonCalls: calls, events, ...(remoteCalls.length ? { hostRequests: remoteCalls } : {}), ...(remoteConfig.client?.calls?.length ? { clientCalls: remoteConfig.client.calls } : {}) };
  } finally {
    await host.dispose().catch(() => {});
  }
}

const cases = [];
const record = async (name, call, args, daemon, run, remoteConfig) => cases.push({ name, call, args, daemon, ...(remoteConfig?.note ? { scripted: remoteConfig.note } : {}), node: await withHost(daemon, run, remoteConfig) });

const S = 'sess_a';
const projectDir = await mkdtemp(join(tmpdir(), 'phone-chat-proj-'));
await record('markSessionRead-changed', 'markSessionRead', [S, 3, false], { list: { sessions: [row(S)] } }, async (h) => {
  await h.listSessions();
  return h.markSessionRead(S, 3, false);
});
await record('markSessionRead-unchanged', 'markSessionRead', [S, 3, false], { list: { sessions: [row(S)] } }, async (h) => {
  await h.listSessions();
  await h.markSessionRead(S, 3, false);
  return h.markSessionRead(S, 3, false);
});
await record('getTaskWorkspace', 'getTaskWorkspace', [], {}, (h) => h.getTaskWorkspace());
await record('abortSession-idle', 'abortSession', [S, {}], { abort: { ...full(S), aborted: false } }, (h) => h.abortSession(S, {}));
await record('submitToSession-accepted', 'submitToSession', [S, 'hi', { id: 'sub1' }], { submit: { ...full(S), accepted: true } }, (h) =>
  h.submitToSession(S, 'hi', { id: 'sub1' }));
await record('resolveToolApproval-approved', 'resolveToolApprovalForSession', [S, 'ap1', { approved: true }], {
  approve: { ...full(S), approved: true },
}, (h) => h.resolveToolApprovalForSession(S, 'ap1', { approved: true }));
await record('resolveToolApproval-settled', 'resolveToolApprovalForSession', [S, 'ap1', { approved: true }], {
  approve: { ...full(S), approved: false },
}, (h) => h.resolveToolApprovalForSession(S, 'ap1', { approved: true }));
await record('setFast', 'setFast', [true, S], { configure: { ...full(S, { fast: true }), value: true } }, (h) => h.setFast(true, S));
await record('setModelRoute', 'setModelRoute', [{ provider: 'p2', model: 'm2' }, S], {
  configure: { ...full(S, { provider: 'p2', model: 'm2' }), value: { provider: 'p2', model: 'm2' } },
}, (h) => h.setModelRoute({ provider: 'p2', model: 'm2' }, S));
await record('stopShellJob-stopped', 'stopShellJob', [S, 't1'], { configure: { ...full(S), value: { stopped: true } } }, (h) => h.stopShellJob(S, 't1'));
await record('stopShellJob-failed', 'stopShellJob', [S, 't1'], { configure: { ...full(S), value: { stopped: false, unconfirmed: true } } }, (h) =>
  h.stopShellJob(S, 't1'));
await record('releaseShellJob-released', 'releaseShellJob', [S, 't1'], { configure: { ...full(S), value: { released: true } } }, (h) =>
  h.releaseShellJob(S, 't1'));
await record('releaseShellJob-throws', 'releaseShellJob', [S, 't1'], { configure: () => { throw new Error('no hold'); } }, (h) =>
  h.releaseShellJob(S, 't1'));
await record('scheduleQuotaResume-true', 'scheduleQuotaResume', [S], { configure: { ...full(S), value: true } }, (h) => h.scheduleQuotaResume(S));
await record('cancelQuotaResume-false', 'cancelQuotaResume', [S], { configure: { ...full(S), value: false } }, (h) => h.cancelQuotaResume(S));
await record('continueSessionInModel-true', 'continueSessionInModel', [S, { provider: 'p2', model: 'm2' }], {
  configure: { ...full(S), value: true },
}, (h) => h.continueSessionInModel(S, { provider: 'p2', model: 'm2' }));
await record('searchSessionContent', 'searchSessionContent', ['needle'], {
  search: [{ sessionId: S, snippet: 'a needle', rank: 1.5, extra: 'dropped' }],
}, (h) => h.searchSessionContent('needle'));
await record('readTranscriptHistory-unsupported', 'readTranscriptHistory', [S, { before: 'it1', limit: 5 }], {
  read: { ...full(S), history: null },
}, (h) => h.readTranscriptHistory(S, { before: 'it1', limit: 5 }));
await record('deleteSession-present', 'deleteSession', [S], { list: { sessions: [row(S)] }, configure: { ...full('ctl'), value: true }, create: full('ctl'), unsubscribe: {} }, (h) =>
  h.deleteSession(S));
await record('deleteSession-missing', 'deleteSession', ['sess_gone'], { list: { sessions: [] }, unsubscribe: {} }, (h) => h.deleteSession('sess_gone'));

const control = { create: full('ctl'), list: { sessions: [row(S)] } };
await record('getQuotaAutoResume-on', 'getQuotaAutoResume', [], { ...control, read: { ...full('ctl'), value: true } }, (h) => h.getQuotaAutoResume());
await record('getQuotaAutoResume-off', 'getQuotaAutoResume', [], { ...control, read: { ...full('ctl'), value: false } }, (h) => h.getQuotaAutoResume());
await record('setQuotaAutoResume-off', 'setQuotaAutoResume', [false], { ...control, configure: { ...full('ctl'), value: false } }, (h) =>
  h.setQuotaAutoResume(false));
await record('renameSession-ok', 'renameSession', [S, 'New name'], { ...control, configure: { ...full('ctl'), value: true } }, (h) =>
  h.renameSession(S, 'New name'));
await record('renameSession-refused', 'renameSession', [S, 'New name'], { ...control, configure: { ...full('ctl'), value: false } }, (h) =>
  h.renameSession(S, 'New name'));
await record('renameSession-empty', 'renameSession', [S, '   '], control, (h) => h.renameSession(S, '   '));
await record('setSessionFavorite', 'setSessionFavorite', [S, true], control, (h) => h.setSessionFavorite(S, true));
await record('startTask', 'startTask', [], {}, (h) => h.startTask());
await record('listProviderModels', 'listProviderModels', [{ quick: false }], {
  ...control,
  read: { ...full('ctl'), value: [{ provider: 'p', id: 'm', name: 'M', effortOptions: [{ value: 'low', label: 'Low' }, { value: '', label: 'x' }], fastCapable: true, contextWindow: 1000 }, { provider: '', id: 'x' }] },
}, (h) => h.listProviderModels({ quick: false }));

// ── batch 2: the calls the first batch left out. Phone-method layer = createRemoteMethods (remote-methods.ts) over the real host.
const clientOf = (extra = {}) => {
  const calls = [];
  return {
    calls,
    deviceName: async () => 'Pixel 9',
    viewedSessionIds: () => [S],
    heldTranscript: () => toolSnapshot,
    requestRead: (id) => calls.push(['requestRead', id]),
    requestTranscriptPage: (id, n) => calls.push(['requestTranscriptPage', id, n]),
    releaseRead: (id) => calls.push(['releaseRead', id]),
    staleView: () => false,
    ...extra,
  };
};
const toolRows = [{ kind: 'tool', id: 'tool1', result: 'full output', rawResult: { raw: 1 }, uiDiff: { d: 1 } }, { kind: 'user', id: 'u1', text: 'hi' }];
const toolSnapshot = { items: toolRows };
const noStale = {};

await record('viewerDevice-named', 'viewerDevice', [], {}, (_h, r) => r.viewerDevice([]), { client: clientOf() });
await record('viewerDevice-default', 'viewerDevice', [], {}, (_h, r) => r.viewerDevice([]), { client: clientOf({ deviceName: async () => '' }) });
await record('readTranscriptItem-found', 'readTranscriptItem', [S, 'tool1'], { read: { ...full(S, { items: toolRows }) } }, (_h, r) =>
  r.readTranscriptItem([S, 'tool1']), { client: clientOf() });
await record('readTranscriptItem-not-viewed', 'readTranscriptItem', [S, 'tool1'], { read: full(S, { items: toolRows }) }, (_h, r) =>
  r.readTranscriptItem([S, 'tool1']), { client: clientOf({ viewedSessionIds: () => [] }) });
await record('readTranscriptItem-not-held', 'readTranscriptItem', [S, 'nope'], { read: full(S, { items: toolRows }) }, (_h, r) =>
  r.readTranscriptItem([S, 'nope']), { client: clientOf() });
// A notification's Allow / Deny and the card's pointer-only refusal are recorded from Node's real push notifier over a real daemon
// (remote-protocol-chat-history.record.mjs, the `notify-` cases).
await record('provideSecretInput-true', 'provideSecretInput', ['req1', 's3cret'], {}, (_h, r) => r.provideSecretInput(['req1', 's3cret']), {
  client: clientOf(), hostReply: true, note: 'hostRequest (the window process) is scripted: the secret slot is not part of the daemon',
});
await record('provideSecretInput-false', 'provideSecretInput', ['req1', 's3cret'], {}, (_h, r) => r.provideSecretInput(['req1', 's3cret']), {
  client: clientOf(), hostReply: false, note: 'hostRequest (the window process) is scripted: the secret slot is not part of the daemon',
});
await record('readCapabilities', 'readCapabilities', [[{ capability: 'getProfile', args: [] }]], { ...control, read: { ...full('ctl'), value: { name: 'Mixy' } } },
  (_h, r) => r.readCapabilities([[{ capability: 'getProfile', args: [] }]]), { client: clientOf() });
await record('readCapabilities-failed', 'readCapabilities', [[{ capability: 'getProfile', args: [] }]], { ...control, read: () => { throw new Error('profile unavailable'); } },
  (_h, r) => r.readCapabilities([[{ capability: 'getProfile', args: [] }]]), { client: clientOf() });
await record('prefetchSession-limit', 'prefetchSession', [S, 40, 'trace1'], { read: full(S, { items: toolRows }) },
  (_h, r) => r.prefetchSession([S, 40, 'trace1']), { client: clientOf(), });
await record('prefetchSession-fails', 'prefetchSession', [S, 40], { read: () => { throw new Error('read failed'); } },
  (_h, r) => r.prefetchSession([S, 40]), { client: clientOf() });
await record('setSessionArchived-true', 'setSessionArchived', [S, true], { ...control, list: { sessions: [row(S)] }, configure: { ...full('ctl'), value: {} } },
  (_h, r) => r.setSessionArchived([S, true]), { client: clientOf() });
await record('setSessionArchived-false', 'setSessionArchived', [S, false], { ...control, list: { sessions: [row(S)] }, configure: { ...full('ctl'), value: {} } },
  (_h, r) => r.setSessionArchived([S, false]), { client: clientOf() });
const submitEcho = (accepted) => (a) => ({ ...full(a.sessionId), sessionId: a.sessionId, accepted });
const createEcho = (a) => full(a.sessionId ?? 'sess_new_1');
await record('submitNewTask-accepted', 'submitNewTask', ['build it', { id: 'sub9' }, {}], { create: createEcho, submit: submitEcho(true), unsubscribe: {}, list: { sessions: [] } },
  (_h, r) => r.submitNewTask(['build it', { id: 'sub9' }, {}]), { client: clientOf() });
await record('submitNewTask-route', 'submitNewTask', ['build it', { id: 'sub11' }, { route: { provider: 'p2', model: 'm2' } }],
  { create: createEcho, submit: submitEcho(true), configure: (a) => ({ ...full(a.sessionId), value: { provider: 'p2', model: 'm2' } }), unsubscribe: {}, list: { sessions: [] } },
  (_h, r) => r.submitNewTask(['build it', { id: 'sub11' }, { route: { provider: 'p2', model: 'm2' } }]), { client: clientOf() });
await record('inheritSession', 'inheritSession', [S, { provider: 'p2', model: 'm2' }, null],
  { projects: [], list: { sessions: [row(S)] }, create: () => full('sess_heir'), configure: (a) => ({ ...full('sess_heir', { inherited: a.action === 'inheritFrom' }), value: a.action === 'inheritFrom' ? { messages: 3 } : {} }), unsubscribe: {} },
  (_h, r) => r.inheritSession([S, { provider: 'p2', model: 'm2' }, null]), { client: clientOf() });
await record('startProject', 'startProject', [projectDir], {}, (_h, r) => r.startProject([projectDir]), { client: clientOf() });
await record('startProjectTask-registered', 'startProjectTask', [projectDir], { projects: [{ name: 'proj', path: projectDir, addedAt: 1 }] }, (_h, r) => r.startProjectTask([projectDir]), { client: clientOf() });
await record('startProjectTask-unknown', 'startProjectTask', [projectDir], {}, (_h, r) => r.startProjectTask([projectDir]), { client: clientOf() });
const missing = () => Object.assign(new Error('session is not available'), { code: 'SESSION_NOT_AVAILABLE' });
const controlValue = (value) => ({ ...full('ctl'), value });
const agentRead = (home) => (a) => {
  if (a.action === 'listAgents') return controlValue(['agent1', 'agent2'].map((id) => ({ id, custom: true, kind: 'bot', name: id, route: { provider: 'p', model: 'm' } })));
  if (a.action === 'agentDefinitionPresence') return controlValue({ agent1: 'present', agent2: 'present' });
  if (a.action) return controlValue(null);
  if (a.sessionId === 'ctl') return full('ctl');
  if (home === 'missing') throw missing();
  return full(a.sessionId, { provider: 'p', model: 'm' });
};
const homeDaemon = (home) => ({ ...control, read: agentRead(home), create: (a) => full(a.sessionId ?? 'ctl'), configure: (a) => controlValue(a.action === 'clearSession' ? null : {}), unsubscribe: {} });
await record('openAgentHome-new', 'openAgentHome', ['agent1'], homeDaemon('missing'), (_h, r) => r.openAgentHome(['agent1']), { client: clientOf() });
await record('openAgentHome-existing', 'openAgentHome', ['agent1'], homeDaemon('existing'), (_h, r) => r.openAgentHome(['agent1']), { client: clientOf() });
await record('openAgentHome-unknown-agent', 'openAgentHome', ['nobody'], homeDaemon('missing'), (_h, r) => r.openAgentHome(['nobody']), { client: clientOf() });
await record('resetAgentHome', 'resetAgentHome', ['agent1'], homeDaemon('existing'), (_h, r) => r.resetAgentHome(['agent1']), { client: clientOf() });
const roomDaemon = { ...homeDaemon('existing'), read: (a) => (a.action === 'getLeadHomeRoute' ? controlValue({ provider: 'p', model: 'm' }) : agentRead('existing')(a)) };
const roomConfig = { name: 'Room', members: ['agent1', 'agent2'] };
await record('agentRoomAction-create', 'agentRoomAction', ['create', [roomConfig]], roomDaemon, (_h, r) => r.agentRoomAction(['create', [roomConfig]]), { client: clientOf() });
await record('agentRoomAction-update', 'agentRoomAction', ['update', ['<roomId>', { name: 'Renamed' }]], roomDaemon, async (_h, r) => {
  const { roomId } = await r.agentRoomAction(['create', [roomConfig]]);
  return r.agentRoomAction(['update', [roomId, { name: 'Renamed' }]]);
}, { client: clientOf(), note: 'the room id is the one the same host minted in create' });
await record('agentRoomAction-remove', 'agentRoomAction', ['remove', ['<roomId>']], roomDaemon, async (_h, r) => {
  const { roomId } = await r.agentRoomAction(['create', [roomConfig]]);
  return r.agentRoomAction(['remove', [roomId]]);
}, { client: clientOf(), note: 'the room id is the one the same host minted in create' });
await record('agentRoomAction-unknown', 'agentRoomAction', ['explode', []], {}, (_h, r) => r.agentRoomAction(['explode', []]), { client: clientOf() });

// submitFeedback: Node's own module over an injected fetch (the relay is not reachable from a recording).
const { submitFeedback } = await import(pathToFileURL(join(exportDir, 'apps/desktop/src/main/feedback-client.ts')).href);
const feedbackId = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const feedbackInput = { id: feedbackId, kind: 'bug', message: 'it broke', replyTo: 'me@example.com' };
for (const [name, respond] of [
  ['submitFeedback-accepted', async () => new Response(JSON.stringify({ id: feedbackId, status: 'accepted' }), { status: 202 })],
  ['submitFeedback-rate-limited', async () => new Response('{}', { status: 429 })],
  ['submitFeedback-unavailable', async () => new Response('{}', { status: 500 })],
  ['submitFeedback-bad-receipt', async () => new Response(JSON.stringify({ id: 'other', status: 'accepted' }), { status: 202 })],
  ['submitFeedback-network', async () => { throw new Error('offline'); }],
]) {
  let result;
  try {
    result = { result: await submitFeedback(feedbackInput, { env: { MIXDOG_RELAY_URL: 'wss://relay.example' }, request: respond }) };
  } catch (error) {
    result = { error: error.message };
  }
  cases.push({ name, call: 'submitFeedback', args: [feedbackInput], daemon: {}, scripted: 'the relay HTTP answer is scripted; feedback-client.ts runs unchanged', node: { ...result, daemonCalls: [], events: [] } });
}

const manifest = {
  exact: true,
  commit: COMMIT,
  tree: execFileSync('git', ['-C', 'C:/Project/mixdog', 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(),
  source: 'git archive of the whole tree; apps/desktop/src/main/session-host.ts run unchanged',
};
await writeFile(outFile, `${JSON.stringify({ manifest, cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
