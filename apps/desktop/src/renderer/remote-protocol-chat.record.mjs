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

async function withHost(daemon, run) {
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
  const root = await mkdtemp(join(tmpdir(), 'phone-chat-host-'));
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => client,
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadSessionSearch: async () => ({ searchSessionMessages: async () => daemon.search ?? [] }),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  const events = [];
  host.subscribeSessions((s) => events.push({ event: 'sessions', ids: s.map((x) => x.id) }));
  host.subscribeSessionStates((u) => events.push({ event: 'sessionState', sessionId: u.sessionId, source: u.source }));
  try {
    const result = await run(host);
    return { result, daemonCalls: calls, events };
  } catch (error) {
    return { error: String(error?.message ?? error), daemonCalls: calls, events };
  } finally {
    await host.dispose().catch(() => {});
  }
}

const cases = [];
const record = async (name, call, args, daemon, run) => cases.push({ name, call, args, daemon, node: await withHost(daemon, run) });

const S = 'sess_a';
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
await record('abortSession-restored', 'abortSession', [S, {}], {
  abort: { ...full(S), aborted: true, restoreText: 'draft', restoredSubmissionIds: ['sub1'] },
}, (h) => h.abortSession(S, {}));
await record('abortSession-idle', 'abortSession', [S, {}], { abort: { ...full(S), aborted: false } }, (h) => h.abortSession(S, {}));
await record('submitToSession-accepted', 'submitToSession', [S, 'hi', { id: 'sub1' }], { submit: { ...full(S), accepted: true } }, (h) =>
  h.submitToSession(S, 'hi', { id: 'sub1' }));
await record('submitToSession-refused', 'submitToSession', [S, 'hi', { id: 'sub2' }], { submit: { ...full(S), accepted: false } }, (h) =>
  h.submitToSession(S, 'hi', { id: 'sub2' }));
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

const manifest = {
  exact: true,
  commit: COMMIT,
  tree: execFileSync('git', ['-C', 'C:/Project/mixdog', 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(),
  source: 'git archive of the whole tree; apps/desktop/src/main/session-host.ts run unchanged',
};
await writeFile(outFile, `${JSON.stringify({ manifest, cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
