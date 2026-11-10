// Records what Node's host (b6f10295a, run unchanged from the exact export) answers a paired phone for the calls the phone-chat host
// adapter owns: the three start calls (no thread; Node's blank snapshot), the remote-session fields of a snapshot, transcript paging
// (`transcript-window.mjs` readTranscriptHistory), the stale-view refusal (`remote-view-staleness.ts` + `remote-methods.ts`), the secret
// and room-action refusals. Real SessionHost, createRemoteMethods, readTranscriptHistory, viewIsStale and createSecretRequests;
// the scripted parts (daemon replies, the project registry store, the worktree registry) are each case's `scripted`/inputs.
//
//   node --import tsx record.mjs <export dir> <out file>      (cwd: <export dir>/apps/desktop)
//
// The export dir is `git archive b6f10295a` of the whole tree. Paths under the case's temp root are written `<ROOT>/...` (separators
// `/`); a replay puts its own root back.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [exportDir, outFile] = process.argv.slice(2);
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
process.env.MIXDOG_DATA_DIR = await mkdtemp(join(tmpdir(), 'phone-chat-host-data-'));
const load = (path) => import(pathToFileURL(join(exportDir, path)).href);
const { SessionHost } = await load('apps/desktop/src/main/session-host.ts');
const { createRemoteMethods } = await load('apps/desktop/src/main/remote-methods.ts');
const { viewIsStale } = await load('apps/desktop/src/main/remote-view-staleness.ts');
const { createSecretRequests } = await load('apps/desktop/src/main/secret-requests.ts');
const { readTranscriptHistory } = await load('src/standalone/session-service/projection/transcript-window.mjs');

const fail = (error) => ({ message: String(error?.message ?? error), ...(error?.code ? { code: error.code } : {}), name: error?.name });
const full = (sessionId, extra = {}) => ({
  sessionId,
  revision: 1,
  full: { sessionId, items: [], queued: [], busy: false, commandBusy: false, provider: 'p', model: 'm', fast: false, ...extra },
});

/** One fresh host over a fresh temp root: `daemon` scripts the session client, `projects` the registry store. */
async function withHost({ daemon = {}, projects = [], hidden = [], worktrees = null, touchThrows = false }, run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phone-chat-host-')));
  const calls = [];
  const client = new Proxy({}, {
    get: (_t, name) => name === 'then' ? undefined : async (args = {}) => {
      if (name === 'close') return undefined;
      calls.push({ method: name, action: args?.action });
      const reply = daemon[name];
      if (reply === undefined) throw new Error(`unscripted daemon call ${String(name)}`);
      return typeof reply === 'function' ? reply(args) : reply;
    },
  });
  const registered = projects.map((entry) => ({ ...entry, path: entry.path.replace('<ROOT>', root) }));
  const storeCalls = [];
  const store = {
    listProjects: () => registered,
    addProject: (path) => {
      storeCalls.push(['addProject', path]);
      let entry = registered.find((p) => p.path === path);
      if (!entry) registered.push((entry = { name: path.split(/[\\/]/).pop(), path, addedAt: 1 }));
      return entry;
    },
    touchProjectSelected: (path) => {
      storeCalls.push(['touchProjectSelected', path]);
      if (touchThrows) throw new Error('registry is read-only');
    },
  };
  const userData = join(root, 'userData');
  await mkdir(userData, { recursive: true });
  if (hidden.length) {
    await writeFile(join(userData, 'desktop-projects.json'), JSON.stringify({ version: 2, aliases: {}, hidden: hidden.map((h) => h.replace('<ROOT>', root)) }));
  }
  const runtime = {
    attachSessionClient: async () => client,
    loadProjects: async () => store,
    loadSessionStore: async () => ({ listProjects: async () => registered }),
    loadSessionSearch: async () => ({ searchSessionMessages: async () => [] }),
    loadStatuslineSegments: async () => ({}),
    executeCodeGraphTool: async () => ({}),
    ...(worktrees ? { loadWorktrees: async () => ({ findWorktreeContaining: async (p) => worktrees(root).find((w) => p === w.path || p.startsWith(`${w.path}\\`) || p.startsWith(`${w.path}/`)) ?? null }) } : {}),
  };
  const host = await SessionHost.create({ userDataPath: userData, resourcesPath: root, appPath: root, packaged: false }, runtime);
  const shells = [];
  host.subscribe((snapshot) => shells.push(snapshot));
  const secrets = createSecretRequests({});
  const remote = createRemoteMethods({
    host,
    // index.ts:1245 — the window process takes the value into the slot the PC card fills.
    hostRequest: async (method, args) => (method === 'provideSecretInput' ? secrets.provide(String(args[0] || ''), typeof args[1] === 'string' ? args[1] : '') : null),
  }, { deviceName: async () => 'Pixel 9' });
  const norm = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value).split(JSON.stringify(root).slice(1, -1)).join('<ROOT>').replaceAll('\\\\', '/'));
  const out = { daemonCalls: calls };
  try {
    out.result = await run({ host, remote, root, store });
  } catch (error) {
    out.error = fail(error);
  }
  out.storeCalls = storeCalls;
  out.shells = shells;
  try {
    out.hiddenAfter = JSON.parse(await readFile(join(userData, 'desktop-projects.json'), 'utf8')).hidden;
  } catch {
    out.hiddenAfter = null;
  }
  await host.dispose().catch(() => {});
  const normalized = norm(out);
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return normalized;
}

const cases = [];
const record = async (group, name, setup, call, args, options, run) => {
  const node = await withHost(options, run);
  cases.push({ group, name, setup, call, args, node, ...(options.note ? { scripted: options.note } : {}) });
};
const dir = async (root, ...names) => {
  for (const name of names) await mkdir(join(root, name), { recursive: true });
};

// ── start calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const proj = { name: 'proj', path: '<ROOT>/proj', addedAt: 1 };
const startCases = [
  ['startTask', 'startTask', [], {}, {}],
  ['startProject-new', 'startProject', ['<ROOT>/proj'], {}, { dirs: ['proj'] }],
  ['startProject-registered', 'startProject', ['<ROOT>/proj'], { projects: [proj] }, { dirs: ['proj'] }],
  ['startProject-tombstone', 'startProject', ['<ROOT>/proj'], { projects: [proj], hidden: ['<ROOT>/proj', '<ROOT>/other'] }, { dirs: ['proj'] }],
  ['startProject-padded', 'startProject', ['  <ROOT>/proj  '], {}, { dirs: ['proj'] }],
  ['startProject-missing', 'startProject', ['<ROOT>/nowhere'], {}, {}],
  ['startProject-below-missing', 'startProject', ['<ROOT>/nowhere/deeper'], {}, {}],
  ['startProject-file', 'startProject', ['<ROOT>/file.txt'], {}, { files: ['file.txt'] }],
  ['startProject-empty', 'startProject', ['   '], {}, {}],
  ['startProject-number', 'startProject', [7], {}, {}],
  ['startProject-touch-throws', 'startProject', ['<ROOT>/proj'], { touchThrows: true }, { dirs: ['proj'] }],
  ['startProjectTask:registered', 'startProjectTask', ['<ROOT>/proj'], { projects: [proj] }, { dirs: ['proj'] }],
  ['startProjectTask:unregistered', 'startProjectTask', ['<ROOT>/proj'], {}, { dirs: ['proj'] }],
  ['startProjectTask:vanished', 'startProjectTask', ['<ROOT>/proj'], { projects: [proj] }, {}],
  ['startProjectTask:registered-file', 'startProjectTask', ['<ROOT>/proj'], { projects: [proj] }, { files: ['proj'] }],
  ['startProjectTask:touch-throws', 'startProjectTask', ['<ROOT>/proj'], { projects: [proj], touchThrows: true }, { dirs: ['proj'] }],
  ['startProjectTask:empty', 'startProjectTask', [''], {}, {}],
];
const worktree = (state = 'ready') => (root) => [{ path: join(root, 'wt'), projectPath: join(root, 'proj'), state }];
startCases.push(
  ['startProjectTask:worktree', 'startProjectTask', ['<ROOT>/wt'], { projects: [proj], worktrees: worktree() }, { dirs: ['proj', 'wt'] }],
  ['startProjectTask:worktree-subfolder', 'startProjectTask', ['<ROOT>/wt/sub'], { projects: [proj], worktrees: worktree() }, { dirs: ['proj', 'wt/sub'] }],
  ['startProjectTask:worktree-not-ready', 'startProjectTask', ['<ROOT>/wt'], { projects: [proj], worktrees: worktree('deleting') }, { dirs: ['proj', 'wt'] }],
  ['startProjectTask:worktree-owner-unregistered', 'startProjectTask', ['<ROOT>/wt'], { projects: [], worktrees: worktree() }, { dirs: ['proj', 'wt'] }],
  ['startProjectTask:worktree-owner-vanished', 'startProjectTask', ['<ROOT>/wt'], { projects: [proj], worktrees: worktree() }, { dirs: ['wt'] }],
);
for (const [name, call, args, options, prepare] of startCases) {
  const setup = { projects: options.projects ?? [], hidden: options.hidden ?? [], worktrees: Boolean(options.worktrees), touchThrows: Boolean(options.touchThrows), dirs: prepare.dirs ?? [], files: prepare.files ?? [] };
  await record('start', name, setup, call, args, options, async ({ remote, root }) => {
    await dir(root, ...setup.dirs);
    for (const file of setup.files) await writeFile(join(root, file), 'x');
    const given = args.map((a) => (typeof a === 'string' ? a.replace('<ROOT>', root) : a));
    return remote[call](given);
  });
}

// ── the remote fields of a snapshot: the catalog read carries `remoteSession` ({ enabled, sessionId }) ────────────────────────
const longId = `sess_${'a'.repeat(300)}`;
for (const [name, remoteSession] of [
  ['off', undefined],
  ['enabled', { enabled: true, sessionId: 'sess_remote_1' }],
  ['enabled-padded-hyphen', { enabled: true, sessionId: 'Aa0_-z' }],
  ['disabled-with-id', { enabled: false, sessionId: 'sess_remote_1' }],
  ['enabled-no-id', { enabled: true }],
  ['enabled-empty-id', { enabled: true, sessionId: '' }],
  ['enabled-bad-chars', { enabled: true, sessionId: 'sess remote' }],
  ['enabled-too-long', { enabled: true, sessionId: longId }],
  ['enabled-number-id', { enabled: true, sessionId: 5 }],
  ['enabled-string-flag', { enabled: 'true', sessionId: 'sess_remote_1' }],
]) {
  await record('remote', `startTask:remote-${name}`, { remoteSession: remoteSession ?? null }, 'startTask', [], { daemon: { list: { sessions: [], ...(remoteSession ? { remoteSession } : {}) } } }, async ({ host, remote }) => {
    await host.listSessions();
    return remote.startTask([]);
  });
}

// ── transcript paging ───────────────────────────────────────────────────────────────────────────────────────────────────────
const rows = Array.from({ length: 30 }, (_, i) => (i % 2 ? { kind: 'assistant', id: `r${i + 1}`, text: `answer ${i + 1} ${'x'.repeat(200)}` } : { kind: 'user', id: `r${i + 1}`, text: `ask ${i + 1} ${'y'.repeat(200)}` }));
const historyCases = [
  ['before-middle', { before: 'r20', limit: 5 }],
  ['before-near-start', { before: 'r3', limit: 5 }],
  ['before-first', { before: 'r1', limit: 5 }],
  ['before-more-than-exist', { before: 'r6', limit: 50 }],
  ['after-middle', { after: 'r10', limit: 5 }],
  ['after-near-end', { after: 'r28', limit: 5 }],
  ['after-last', { after: 'r30', limit: 5 }],
  ['before-byte-floor', { before: 'r25', limit: 20, byteBudget: 1 }],
  ['before-byte-budget', { before: 'r25', limit: 20, byteBudget: 1500 }],
  ['after-byte-floor', { after: 'r2', limit: 20, byteBudget: 1 }],
  ['after-byte-budget', { after: 'r2', limit: 20, byteBudget: 1500 }],
  ['before-small-limit-floor', { before: 'r25', limit: 3, byteBudget: 1 }],
];
const liveEntry = { runtime: { getState: () => ({ items: rows }) } };
for (const [name, request] of historyCases) {
  const answer = await readTranscriptHistory(liveEntry, 'sess_a', undefined, request);
  cases.push({ group: 'history', name, setup: { rows: rows.length, source: 'live' }, call: 'readTranscriptHistory', args: ['sess_a', request], node: { result: JSON.parse(JSON.stringify(answer)) } });
}
// A session no host holds: the stored reader answers the page by cursor (session-views.mjs); a row it cannot find is `cursorMissing`.
const stored = (page) => async () => page;
for (const [name, request, page] of [
  ['stored-before', { before: 'r20', limit: 5 }, { items: rows.slice(14, 19), transcriptHasOlder: true, transcriptHasNewer: true }],
  ['stored-after', { after: 'r10', limit: 5 }, { items: rows.slice(10, 15), transcriptHasOlder: true, transcriptHasNewer: true }],
  ['stored-vanished-row', { before: 'gone', limit: 5 }, { items: [], cursorMissing: true }],
  ['stored-vanished-after', { after: 'gone', limit: 5 }, { items: [], cursorMissing: true }],
  ['stored-unsupported-reader', { before: 'r20', limit: 5 }, { items: rows.slice(14, 19) }],
]) {
  const answer = await readTranscriptHistory(null, 'sess_a', stored(page), request);
  cases.push({
    group: 'history', name, setup: { source: 'stored', page }, call: 'readTranscriptHistory', args: ['sess_a', request],
    node: { result: JSON.parse(JSON.stringify(answer)) }, scripted: 'the stored reader (session-views.mjs transcriptCursor) is scripted with `page`',
  });
}
// The phone's request check (ipc-validation.ts requiredTranscriptHistoryRequest, through remote-session-methods.ts).
for (const [name, request] of [
  ['valid', { before: 'r20', limit: 5 }],
  ['valid-budget', { after: 'r20', limit: 512, byteBudget: 9000 }],
  ['valid-null-budget', { before: 'r20', limit: 5, byteBudget: null }],
  ['both', { before: 'r2', after: 'r3', limit: 5 }],
  ['neither', { limit: 5 }],
  ['limit-zero', { before: 'r2', limit: 0 }],
  ['limit-513', { before: 'r2', limit: 513 }],
  ['limit-float', { before: 'r2', limit: 2.5 }],
  ['limit-string', { before: 'r2', limit: '5' }],
  ['budget-zero', { before: 'r2', limit: 5, byteBudget: 0 }],
  ['budget-float', { before: 'r2', limit: 5, byteBudget: 1.5 }],
  ['id-number', { before: 7, limit: 5 }],
  ['id-empty', { before: '', limit: 5 }],
  ['id-513', { before: 'a'.repeat(513), limit: 5 }],
  ['position-bad', { before: 'r2', limit: 5, position: 'x' }],
  ['position-ok', { before: 'r2', limit: 5, position: 's:1:2' }],
  ['not-an-object', 'r2'],
]) {
  const daemon = { read: () => ({ ...full('sess_a'), history: { items: [], hasOlder: false, hasNewer: false } }) };
  await record('history-request', name, { request }, 'readTranscriptHistory', ['sess_a', request], { daemon }, async ({ remote }) => remote.readTranscriptHistory(['sess_a', request]));
}

// ── the stale-view refusal ─────────────────────────────────────────────────────────────────────────────────────────────────
const u = (id, device) => ({ kind: 'user', id, text: id, ...(device === undefined ? {} : { device }) });
const a = (id) => ({ kind: 'assistant', id, text: id });
const staleCases = [
  ['fresh-same-rows', [u('u1', 'Pixel 9'), a('a1')], [u('u1', 'Pixel 9'), a('a1')]],
  ['other-device-prompt', [u('u1', 'Pixel 9'), a('a1')], [u('u1', 'Pixel 9'), a('a1'), u('u2', 'Laptop')]],
  ['own-device-prompt', [u('u1', 'Pixel 9'), a('a1')], [u('u1', 'Pixel 9'), a('a1'), u('u2', 'Pixel 9')]],
  ['prompt-without-device', [u('u1', 'Pixel 9')], [u('u1', 'Pixel 9'), u('u2')]],
  ['prompt-empty-device', [u('u1', 'Pixel 9')], [u('u1', 'Pixel 9'), u('u2', '')]],
  ['assistant-only-news', [u('u1', 'Pixel 9')], [u('u1', 'Pixel 9'), a('a2')]],
  ['news-above-held-window', [a('a5'), a('a6')], [u('u1', 'Laptop'), a('a5'), a('a6')]],
  ['held-first-row-gone', [a('a5'), a('a6')], [u('u1', 'Laptop'), a('a7')]],
  ['no-held', null, [u('u2', 'Laptop')]],
  ['no-latest', [u('u1', 'Pixel 9')], null],
  ['empty-held', [], [u('u2', 'Laptop')]],
  ['held-rows-without-ids', [{ kind: 'user', text: 'x' }], [u('u2', 'Laptop')]],
];
const { createRelayDeviceMethods } = await load('apps/desktop/src/main/remote-relay-device-methods.ts');
for (const [name, held, latest] of staleCases) {
  const node = await withHost({ daemon: { submit: { ...full('sess_a'), accepted: true } } }, async ({ host }) => {
    const refreshed = [];
    const methods = createRelayDeviceMethods({
      base: { host, hostRequest: async () => null },
      deviceAlias: () => 'Pixel 9',
      listClients: async () => [],
      fileDownloads: { sessionRemoved() {} },
      push: {},
      nativePush: {},
      approvalNotifications: {},
      sessionStates: { latestItems: () => latest ?? undefined, refresh: (id) => refreshed.push(id) },
    });
    // The relay leg's encoder: what this connection was last shown (relay-clients `resumePoint().held`).
    const state = { credentialId: 'cred1', visibleSessionIds: new Set(), sessionStateEncoders: new Map(held ? [['sess_a', { resumePoint: () => ({ held: { items: held } }) }]] : []) };
    const table = methods.methodsFor('client1', state);
    let outcome;
    try {
      outcome = { result: await table.submitToSession(['sess_a', 'hi', { id: 'sub1' }]) };
    } catch (error) {
      outcome = { error: fail(error) };
    }
    return { ...outcome, refreshed };
  });
  cases.push({ group: 'stale', name, setup: { held, latest }, call: 'submitToSession', args: ['sess_a', 'hi', { id: 'sub1' }], node, scripted: 'the relay leg\'s held rows and the fan-out\'s latest rows are scripted; remote-relay-device-methods.ts staleView runs unchanged' });
}

// ── refusal texts ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const SECRET = 'secret_abcdefgh1234';
for (const [name, args] of [
  ['valid', [SECRET, 's3cret']],
  ['valid-min-id', ['secret_abcdefgh', 'v']],
  ['valid-max-id', [`secret_${'a'.repeat(80)}`, 'v']],
  ['valid-value-4096', [SECRET, 'v'.repeat(4096)]],
  ['padded-id', [`  ${SECRET}  `, 's3cret']],
  ['malformed-id', ['not-a-secret', 's3cret']],
  ['short-id', ['secret_abc', 's3cret']],
  ['long-id-81', [`secret_${'a'.repeat(81)}`, 's3cret']],
  ['bad-id-chars', ['secret_abcdefgh!!', 's3cret']],
  ['empty-value', [SECRET, '']],
  ['value-4097', [SECRET, 'v'.repeat(4097)]],
  ['value-not-a-string', [SECRET, 42]],
  ['value-missing', [SECRET]],
  ['value-spaces', [SECRET, '   ']],
  ['id-empty', ['', 's3cret']],
  ['id-blank', ['   ', 's3cret']],
  ['id-not-a-string', [5, 's3cret']],
  ['id-121', [`secret_${'a'.repeat(113)}`, 's3cret']],
]) {
  await record('secret', name, {}, 'provideSecretInput', args, {}, async ({ remote }) => remote.provideSecretInput(args));
}
for (const [name, args] of [
  ['unknown', ['bogus', []]],
  ['unknown-padded', ['  bogus  ', []]],
  ['proceed', ['proceed', ['room_x']]],
  ['prototype-name', ['constructor', []]],
  ['to-string', ['toString', []]],
  ['empty', ['', []]],
  ['blank', ['   ', []]],
  ['not-a-string', [5, []]],
  ['too-long-33', ['a'.repeat(33), []]],
  ['long-32', ['a'.repeat(32), []]],
  ['upper-case', ['Create', []]],
  ['args-not-array', ['bogus', 'x']],
]) {
  await record('room', name, {}, 'agentRoomAction', args, {}, async ({ remote }) => remote.agentRoomAction(args));
}
const control = { create: full('ctl'), list: { sessions: [] } };
for (const [name, agentId] of [['unknown-agent', 'nobody'], ['padded-unknown-agent', '  nobody  '], ['empty', ''], ['not-a-string', 3], ['too-long-201', 'a'.repeat(201)], ['bad-chars', 'bad id!']]) {
  const daemon = {
    ...control,
    read: (arg) => (arg.action === 'listAgents' ? { ...full('ctl'), value: [{ id: 'agent1', custom: true, kind: 'bot', name: 'agent1', route: { provider: 'p', model: 'm' } }] }
      : arg.action === 'agentDefinitionPresence' ? { ...full('ctl'), value: { agent1: 'present' } }
      : arg.action ? { ...full('ctl'), value: null } : full('ctl')),
  };
  await record('home', `openAgentHome-${name}`, { agents: ['agent1'] }, 'openAgentHome', [agentId], { daemon }, async ({ remote }) => remote.openAgentHome([agentId]));
  await record('home', `resetAgentHome-${name}`, { agents: ['agent1'] }, 'resetAgentHome', [agentId], { daemon }, async ({ remote }) => remote.resetAgentHome([agentId]));
}

const manifest = {
  exact: true,
  commit: COMMIT,
  tree: execFileSync('git', ['-C', 'C:/Project/mixdog', 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(),
  source: 'git archive of the whole tree; session-host.ts, remote-methods.ts, transcript-window.mjs, remote-view-staleness.ts and secret-requests.ts run unchanged',
};
await writeFile(outFile, `${JSON.stringify({ manifest, cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
