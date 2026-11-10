#!/usr/bin/env node
// The desktop roster over sessions the b6f10295a product itself wrote to disk, and the fork the desktop makes.
//
// Node's own session code (createSession / askSession against a scripted provider, compactSessionMessages, the desktop's
// DesktopSessionMetadata, createInheritance) writes a data directory and a desktop
// profile; the desktop's catalog (`SessionHost.sessionCatalog`: listStoredSessionSummariesAsync -> desktopSessionSummaries ->
// withArchiveFlags -> withRetiredFlags -> withFavoriteFlags -> withReadCursors) then answers the roster over them.
// The core migrates that directory + profile and lists it; every row must equal Node's row.
//
// The clock moves only when the script advances it (see below). The listing is the product's own
// (`listStoredSessionSummariesAsync()`, the desktop's SessionHost.listSessions call), and the legacy session
// is written by the v1.4.5 tag's own store.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-roster-rows.mjs --tree <tree>
// Output: native/core/fixtures/roster-rows/{.mixdog,profile,answers.json,MANIFEST.json}
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, GIT_TIMEOUT_MS, OPERATION_TIMEOUT_MS, REPO_ROOT, exactProductIdentity, parseArgs, resolveTree, within, writeSetManifest } from './lib/common.mjs';
import { installDeterministicWorld } from './lib/deterministic-world.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, COMMIT);
const out = join(FIXTURES_ROOT, 'roster-rows');
const root = join(tmpdir(), 'roster-rows-live');
rmSync(root, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
const home = join(root, '.mixdog');
const data = join(home, 'data');
const profile = join(root, 'profile');
const work = join(root, 'work');
const tasks = join(root, 'tasks');
const projectA = join(root, 'proj', 'a');
const projectB = join(root, 'proj', 'b');
for (const dir of [data, profile, work, tasks, projectA, projectB]) mkdirSync(dir, { recursive: true });
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = root;
for (const [key, sub] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['MIXDOG_DESKTOP_USER_DATA', 'profile'], ['MIXDOG_CONFIG_DIR', 'config'], ['MIXDOG_RUNTIME_ROOT', 'runtime']]) process.env[key] = join(root, sub);
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) {
  if (k !== 'MIXDOG_DISABLE_MCP' && k !== 'MIXDOG_DISABLE_SKILLS') process.env[k] = v;
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
process.env.MIXDOG_DISABLE_MODEL_PREFETCH = '1';
process.env.MIXDOG_DISABLE_MODEL_CATALOG_WARMUP = '1';

// The product's world moves only when this script advances it: everything a step writes carries that step's time (as the
// desktop's fork does, where create and carry read one tick), and nothing else (ids, the process id, random bytes) reads the
// real world, so recording twice writes the same bytes.
const world = installDeterministicWorld({ start: 1_700_000_000_000, pid: 4242 });
const advance = world.advance;
const load = (p) => import(pathToFileURL(join(tree, p)).href);
const { saveSession } = await load('src/runtime/agent/orchestrator/session/store.mjs');
const manager = await load('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const { listStoredSessionSummariesAsync } = await load('src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const { drainSessionStore } = await load('src/runtime/agent/orchestrator/session/store.mjs');
const { _flushPendingSummaryOps, compactSummaryIndex } = await load('src/runtime/agent/orchestrator/session/store-summary-index.mjs');
// The daemon keeps the session catalog DB and answers an ordinary listing from it; this process is made its writer the way Node's own tests do.
const { createInheritance } = await load('src/session-runtime/lifecycle/inheritance.mjs');
const { createAgentRoomFileStore, createAgentRooms } = await load('apps/desktop/src/main/agent-rooms.ts');
const { DesktopSessionMetadata } = await load('apps/desktop/src/main/desktop-session-metadata.ts');
const { desktopSessionSummaries } = await load('apps/desktop/src/main/desktop-state.ts');
const { projectIdentity, sessionProjectKey } = await load('apps/desktop/src/shared/project-identity.ts');

const stub = {
  name: 'stub',
  contextWindow: 128000,
  async send(messages) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    return { content: text.includes('summar') || text.includes('Summar') || text.includes('compact') ? 'a summary of the conversation' : `reply to ${text.slice(0, 24)}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
const route = { provider: 'stub', model: 'stub-model' };
// The v1.4.5 tag (`git archive`, read-only snapshot), whose own store writes the legacy session: one JSON file per session, the shape
// the product still reads. It runs in a child process on a data directory of its own (its summary index is another format), under
// the same deterministic world; only the session's file is brought over.
const V145_COMMIT = '69fe41b056d3407d7fc7da10ed71e3960b497166';
const v145 = join(root, 'v145');
const v145Data = join(root, 'v145-data');
const gitOf = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
if (gitOf('rev-parse', 'v1.4.5^{commit}') !== V145_COMMIT) throw new Error('v1.4.5 does not point at 69fe41b05');
mkdirSync(v145, { recursive: true });
execFileSync('git', ['archive', '--format=tar', '-o', join(root, 'v145.tar'), V145_COMMIT, 'src', 'package.json'], { cwd: REPO_ROOT, timeout: GIT_TIMEOUT_MS });
execFileSync('tar', ['-xf', join(root, 'v145.tar'), '-C', v145], { timeout: GIT_TIMEOUT_MS });
symlinkSync(join(tree, 'node_modules'), join(v145, 'node_modules'), 'junction');
const writeV145Session = (cwd, at, prompt) => {
  const written = execFileSync(process.execPath, [new URL('./lib/write-v145-session.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), v145, cwd, String(at), prompt], {
    encoding: 'utf8',
    timeout: OPERATION_TIMEOUT_MS,
    env: { ...process.env, MIXDOG_DATA_DIR: v145Data, MIXDOG_HOME: v145Data },
  }).trim();
  copyFileSync(join(v145Data, 'sessions', `${written}.json`), join(data, 'sessions', `${written}.json`));
  return written;
};
const project = (path) => ({ classification: 'project', projectPath: path });
const lead = (extra) => {
  advance(1000);
  return manager.createSession({ ...route, owner: 'user', sourceType: 'lead', agent: 'lead', ...extra });
};
const ids = {};
// The catalog's rows as the product lists them: its ordinary listing (with the lead gate, the compaction counts and the catalog order of the product), after the store has written what it holds.
const rawRows = async () => {
  await within('drain the session store', drainSessionStore());
  _flushPendingSummaryOps({ sync: true }); // the summary rows the store queued, which the product's timer writes
  await within('fold the summary log into its index', compactSummaryIndex());
  return within('list the stored sessions', listStoredSessionSummariesAsync());
};
const metadata = new DesktopSessionMetadata(() => profile);
await within('load the desktop metadata', metadata.load());
const registered = [projectA, projectB];

await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  const ask = (id, prompt, cwd) => {
    advance(1000);
    return within(`ask ${id}`, manager.askSession(id, prompt, null, undefined, cwd, undefined, {}));
  };
  ids.plain = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.plain, 'hello there', projectA);
  ids.task = lead({ cwd: tasks, desktopSession: { classification: 'task', projectPath: null } }).id;
  await ask(ids.task, 'a task thread', tasks);
  ids.bare = lead({ cwd: projectB, desktopSession: project(projectB) }).id; // no message yet
  ids.compacted = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  // Enough text that the compaction really trims it (an unchanged compaction records no count).
  for (let turn = 0; turn < 12; turn += 1) await ask(ids.compacted, `request ${turn} ${'context '.repeat(400)}`, projectA);
  await within('compact the session', manager.compactSessionMessages(ids.compacted));
  if (!(manager.loadSession(ids.compacted).compaction?.compactCount >= 1)) throw new Error('the compaction did not change the session');
  ids.legacy = lead({ cwd: projectB }).id; // the desktop's classification not yet stored
  await ask(ids.legacy, 'a legacy thread', projectB);
  ids.archived = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.archived, 'to be archived', projectA);
  ids.favorite = lead({ cwd: projectB, desktopSession: project(projectB) }).id;
  await ask(ids.favorite, 'to be a favorite', projectB);
  ids.read = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.read, 'to be read', projectA);
  // A session saved by an older product: the v1.4.5 tag's own store writes it, as the one JSON file that release kept.
  advance(1000);
  ids.old = writeV145Session(projectA, world.now(), 'an old thread');
  ids.worker = manager.createSession({ ...route, owner: 'agent', agent: 'worker', ownerSessionId: ids.plain, parentSessionId: ids.plain, sourceType: 'lead', agentTag: 'w1', taskType: 'work', cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.worker, 'a worker turn', projectA);

  // A session outside every registered project, and one in a managed worktree of a registered one.
  ids.stray = lead({ cwd: work, desktopSession: project(work) }).id;
  await ask(ids.stray, 'a stray thread', work);
  const worktree = join(projectA, '.worktrees', 'feat');
  mkdirSync(worktree, { recursive: true });
  ids.worktree = lead({ cwd: worktree, desktopSession: project(projectA) }).id;
  await ask(ids.worktree, 'a worktree thread', worktree);
  const bound = manager.loadSession(ids.worktree);
  bound.workspace = { worktreeId: 'w1', cwd: worktree, projectPath: projectA };
  await within('save the bound session', saveSession(bound));
  // The desktop's fork (`inheritSession`): the heir is created where the source's registered project is, then inheritFrom carries
  // the conversation into it.
  const forkOf = async (sourceId, rows) => {
    advance(60_000);
    const row = rows.find((r) => r.id === sourceId);
    const key = sessionProjectKey(row ?? {}, registered.map((p) => projectIdentity(p)));
    const projectPath = registered.find((p) => projectIdentity(p) === key) ?? null;
    const cwd = projectPath ?? tasks;
    const desktopSession = projectPath ? project(projectPath) : { classification: 'task', projectPath: null };
    const heir = lead({ cwd, desktopSession });
    const inheritance = createInheritance(
      { getSession: () => manager.getSession(heir.id), getRoute: () => route, mgr: manager, createCurrentSession: null, invalidateContextStatusCache() {}, getReservedSessionId: () => null },
      { compactConversation: async () => null, saveSession }
    );
    await within('inherit', inheritance.inheritFrom(sourceId, { compact: false }));
    return heir.id;
  };
  // The desktop's rename (renameSession): the runtime's manual title, then the desktop's own name; done before the forks, so a
  // fork is made of the session as the roster shows it.
  if ((await within('rename', manager.updateSessionManualTitle(ids.task, 'My task'))) !== true) throw new Error('the rename was refused');
  await within('desktop name', metadata.setName(ids.task, 'My task'));
  // Archived and favorite are the desktop's own state of a session; they are set before the forks, so a fork is made of a session
  // that holds them.
  await within('archive', metadata.setArchived(ids.archived, true));
  await within('favorite', metadata.setFavorite(ids.favorite, true));
  ids.fork = await forkOf(ids.plain, await rawRows());
  ids.forkOfTask = await forkOf(ids.task, await rawRows());
  ids.forkOfStray = await forkOf(ids.stray, await rawRows());
  ids.forkOfWorktree = await forkOf(ids.worktree, await rawRows());
  ids.forkOfArchived = await forkOf(ids.archived, await rawRows());
  ids.forkOfFavorite = await forkOf(ids.favorite, await rawRows());

});

// The desktop's metadata, written through its own methods.
await within('mark read', metadata.markRead(ids.read, 0, true, { compactCount: 0, messageCount: 2 }));
await within('mark read', metadata.markRead(ids.read, 2, false, { compactCount: 0, messageCount: 2 }));
const compactedNow = manager.loadSession(ids.compacted);
await within('mark read', metadata.markRead(ids.compacted, 1, true, { compactCount: compactedNow.compaction.compactCount, messageCount: 4 }));

// A deleted bot's home thread: retired, titled with the bot's name.
ids.home = (await load('src/runtime/agent/orchestrator/session/agent-home.mjs')).agentHomeSessionId?.('kestrel') ?? null;
if (ids.home) {
  await _withRegisteredProviderForTestAsync('stub', stub, async () => {
    manager.createSession({ id: ids.home, ...route, owner: 'user', sourceType: 'lead', agent: 'lead', cwd: tasks, desktopSession: { classification: 'task', projectPath: null } });
    await within('ask home', manager.askSession(ids.home, 'hello kestrel', null, undefined, tasks, undefined, {}));
  });
  metadata.rememberRetiredTitle(ids.home, 'Kestrel');
  await within('retire', metadata.setRetired(ids.home, true));
}

// Two rooms, built through the desktop's own room creation (`createAgentRooms.create`: the log session, the record, the title):
// one whose log stays in the catalog (listed) and one whose log is gone (unlisted: the catalog synthesizes its row).
const AGENTS = [
  { id: 'gh', custom: true, kind: 'bot', label: 'GitHub', route },
  { id: 'rel', custom: true, kind: 'bot', label: 'Release', route },
  { id: 'bench', custom: true, kind: 'bot', label: 'Bench', route },
];
const unused = async () => {
  throw new Error('not used by a room being created');
};
const agentRooms = createAgentRooms({
  store: createAgentRoomFileStore(join(profile, 'agent-rooms.json')),
  listAgents: async () => AGENTS,
  sessionExists: async () => false,
  createSession: (id, params) =>
    _withRegisteredProviderForTestAsync('stub', stub, async () => {
      advance(1000);
      manager.createSession({ id, ...params, owner: 'user', sourceType: 'lead', agent: 'lead' });
    }),
  renameSession: async (id, title) => {
    if ((await within('room rename', manager.updateSessionManualTitle(id, title))) !== true) throw new Error('the room rename was refused');
    await within('room name', metadata.setName(id, title));
  },
  taskWorkspace: async () => tasks,
  republishCatalog() {},
  republish() {},
  appendRows: unused,
  readItems: unused,
  submit: unused,
  decideTurn: unused,
  readSnapshot: unused,
  abort: unused,
  approve: unused,
  deleteSession: unused,
  setArchived: unused,
  startOver: unused,
  resetMember: unused,
  now: world.now,
});
advance(1000);
const listedRoom = await within('create the listed room', agentRooms.create({ name: 'Release check', members: ['gh', 'rel'] }));
advance(1000);
const unlistedRoom = await within('create the unlisted room', agentRooms.create({ name: 'Gone log', members: ['rel', 'bench'] }));
await within('delete the unlisted room log', manager.deleteSession(unlistedRoom.sessionId));
ids.listedRoom = listedRoom.sessionId;
ids.unlistedRoom = unlistedRoom.sessionId;
await within('rooms ready', agentRooms.ready());
await within('flush the desktop metadata', metadata.flush());

// What the desktop's catalog answers over it all.
const rawSessionRows = await rawRows();
const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
// `SessionHost.sessionCatalog`, in its order.
const rosterOf = (rows) =>
  metadata.withReadCursors(
    metadata.withFavoriteFlags(
      metadata.withRetiredFlags(metadata.withArchiveFlags(agentRooms.withRooms(desktopSessionSummaries(rows, metadata.titles, metadata.names, tasks))))
    )
  );
const roster = rosterOf(rawSessionRows);
// The daemon lays what is live over the catalog's rows before the desktop projects them (withRuntimeActivity): the same roster
// with a session's live flags set on its row.
const overlays = [
  { id: ids.plain, live: { working: true } },
  { id: ids.plain, live: { agentWorking: true } },
  { id: ids.task, live: { working: true, agentWorking: true } },
  { id: ids.favorite, live: { awaitingApproval: true, awaitingQuestion: true } },
  { id: ids.read, live: { handedBy: ['kestrel'] } },
].map(({ id, live }) => ({ id, live, row: jsonSafe(rosterOf(rawSessionRows.map((row) => (row.id === id ? { ...row, ...live } : row))).find((row) => row.id === id)) }));
const headerOf = (id) => {
  const { messages: _messages, ...header } = manager.loadSession(id);
  return jsonSafe(header);
};
const answers = {
  commit: COMMIT,
  
  taskWorkspace: tasks,
  registeredProjects: registered,
  agents: AGENTS,
  ids,
  roster: jsonSafe(roster),
  overlays,
  forks: [
    { source: ids.stray, heir: ids.forkOfStray, sourceHeader: headerOf(ids.stray), heirHeader: headerOf(ids.forkOfStray) },
    { source: ids.worktree, heir: ids.forkOfWorktree, sourceHeader: headerOf(ids.worktree), heirHeader: headerOf(ids.forkOfWorktree) },
    { source: ids.plain, heir: ids.fork, sourceHeader: headerOf(ids.plain), heirHeader: headerOf(ids.fork) },
    { source: ids.task, heir: ids.forkOfTask, sourceHeader: headerOf(ids.task), heirHeader: headerOf(ids.forkOfTask) },
    { source: ids.archived, heir: ids.forkOfArchived, sourceHeader: headerOf(ids.archived), heirHeader: headerOf(ids.forkOfArchived) },
    { source: ids.favorite, heir: ids.forkOfFavorite, sourceHeader: headerOf(ids.favorite), heirHeader: headerOf(ids.forkOfFavorite) },
  ],
};
for (const { source, heir, sourceHeader, heirHeader } of answers.forks) {
  if (!(heirHeader.createdAt > sourceHeader.createdAt)) throw new Error(`fork ${heir} of ${source} shares its source's time`);
}
mkdirSync(out, { recursive: true });
cpSync(join(data, 'sessions'), join(out, '.mixdog', 'data', 'sessions'), { recursive: true, filter: (path) => !path.endsWith('.lock') && !path.endsWith('.lock-journal') });
cpSync(profile, join(out, 'profile'), { recursive: true });
writeFileSync(join(out, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
const rel = 'benchmarks/rust-core/recorders/record-roster-rows.mjs';
writeSetManifest(out, { set: 'roster-rows', recorder: rel, command: `(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree>`, identity, extra: { legacyWriter: { tag: 'v1.4.5', tagCommit: V145_COMMIT, writer: 'benchmarks/rust-core/recorders/lib/write-v145-session.mjs: the tag manager.createSession + askSession, saved by the tag store.mjs saveSession' } } });
console.error(`recorded ${roster.length} roster rows`);
// The working tree holds a copy of the tag's source and every session written; a run leaves nothing behind.
rmSync(root, { recursive: true, force: true, maxRetries: 5 });
process.exit(0);
