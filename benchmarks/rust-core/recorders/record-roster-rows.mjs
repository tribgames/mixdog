#!/usr/bin/env node
// The desktop roster over sessions the b6f10295a product itself wrote to disk, and the fork the desktop makes.
//
// Node's own session code (createSession / askSession against a scripted provider, compactSessionMessages, the desktop's
// DesktopSessionMetadata, createInheritance) writes a data directory and a desktop
// profile; the desktop's catalog (`SessionHost.sessionCatalog`: listStoredSessionSummaryPage -> desktopSessionSummaries ->
// withArchiveFlags -> withRetiredFlags -> withFavoriteFlags -> withReadCursors) then answers the roster over them.
// The core migrates that directory + profile and lists it; every row must equal Node's row.
//
// The clock reads whole seconds of real time (see below).
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-roster-rows.mjs --tree <tree>
// Output: native/core/fixtures/roster-rows/{.mixdog,profile,answers.json,MANIFEST.json}
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';

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

// The product's clock reads whole seconds of real time, so what a step writes within one second carries one time (as the desktop's
// fork does when create and carry fall in the same tick); file locks still see real time pass.
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => Math.floor(realNow() / 1000) * 1000 + shift;
// Time moves on a minute (no waiting) before each fork, so no heir shares a second with its source.
const later = () => {
  shift += 60_000;
};

const load = (p) => import(pathToFileURL(join(tree, p)).href);
const { saveSession } = await load('src/runtime/agent/orchestrator/session/store.mjs');
const manager = await load('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const { _sessionSummary } = await load('src/runtime/agent/orchestrator/session/store-summary-index.mjs');
const { isLeadVisibleRow } = await load('src/runtime/agent/orchestrator/session/store-summary-catalog.mjs');
const { byActivityThenId } = await load('src/runtime/agent/orchestrator/session/catalog-db/schema.mjs');
const { createInheritance } = await load('src/session-runtime/lifecycle/inheritance.mjs');
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
const project = (path) => ({ classification: 'project', projectPath: path });
const lead = (extra) => manager.createSession({ ...route, owner: 'user', sourceType: 'lead', agent: 'lead', ...extra });
let legacySession;
const ids = {};
// The catalog's rows as the product's own index writer builds them on a save (_sessionSummary of each stored session), the lead
// gate, and the catalog's order (the Node catalog DB is off on this SQLite: session-catalog-db disabled, and its JSON path reads
// a row off the session file without its compaction count until the next save).
const rawRows = () =>
  readdirSync(join(data, 'sessions'))
    .flatMap((name) => (/^(sess_[^.]+)\.(log\.jsonl|json)$/.exec(name) ? [RegExp.$1] : []))
    .map((id) => _sessionSummary(manager.loadSession(id)))
    .filter(isLeadVisibleRow)
    .sort(byActivityThenId);
const metadata = new DesktopSessionMetadata(() => profile);
await metadata.load();
const registered = [projectA, projectB];

await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  const ask = (id, prompt, cwd) => manager.askSession(id, prompt, null, undefined, cwd, undefined, {});
  ids.plain = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.plain, 'hello there', projectA);
  ids.task = lead({ cwd: tasks, desktopSession: { classification: 'task', projectPath: null } }).id;
  await ask(ids.task, 'a task thread', tasks);
  ids.bare = lead({ cwd: projectB, desktopSession: project(projectB) }).id; // no message yet
  ids.compacted = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  // Enough text that the compaction really trims it (an unchanged compaction records no count).
  for (let turn = 0; turn < 12; turn += 1) await ask(ids.compacted, `request ${turn} ${'context '.repeat(400)}`, projectA);
  await manager.compactSessionMessages(ids.compacted);
  if (!(manager.loadSession(ids.compacted).compaction?.compactCount >= 1)) throw new Error('the compaction did not change the session');
  ids.legacy = lead({ cwd: projectB }).id; // the desktop's classification not yet stored
  await ask(ids.legacy, 'a legacy thread', projectB);
  ids.archived = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.archived, 'to be archived', projectA);
  ids.favorite = lead({ cwd: projectB, desktopSession: project(projectB) }).id;
  await ask(ids.favorite, 'to be a favorite', projectB);
  ids.read = lead({ cwd: projectA, desktopSession: project(projectA) }).id;
  await ask(ids.read, 'to be read', projectA);
  // A session saved by an older product: no creation time, no desktop classification.
  ids.old = lead({ cwd: projectA }).id;
  await ask(ids.old, 'an old thread', projectA);
  const older = manager.loadSession(ids.old);
  delete older.createdAt;
  delete older.desktopSession;
  delete older.title;
  legacySession = older;
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
  await saveSession(bound);
  // The desktop's fork (`inheritSession`): the heir is created where the source's registered project is, then inheritFrom carries
  // the conversation into it.
  const forkOf = async (sourceId, rows) => {
    later();
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
    await inheritance.inheritFrom(sourceId, { compact: false });
    return heir.id;
  };
  ids.fork = await forkOf(ids.plain, rawRows());
  ids.forkOfTask = await forkOf(ids.task, rawRows());
  ids.forkOfStray = await forkOf(ids.stray, rawRows());
  ids.forkOfWorktree = await forkOf(ids.worktree, rawRows());

});

// The desktop's metadata, written through its own methods.
await metadata.setArchived(ids.archived, true);
await metadata.setFavorite(ids.favorite, true);
await metadata.setFavorite(ids.forkOfTask, true);
await metadata.markRead(ids.read, 0, true, { compactCount: 0, messageCount: 2 });
await metadata.markRead(ids.read, 2, false, { compactCount: 0, messageCount: 2 });
const compactedNow = manager.loadSession(ids.compacted);
await metadata.markRead(ids.compacted, 1, true, { compactCount: compactedNow.compaction.compactCount, messageCount: 4 });
// The desktop's rename (renameSession): the runtime's manual title, then the desktop's own name. The legacy sidebar title is what
// the roster shows for a session that has none of its own.
if ((await manager.updateSessionManualTitle(ids.task, 'My task')) !== true) throw new Error('the rename was refused');
await metadata.setName(ids.task, 'My task');
metadata.rememberGeneratedTitle(ids.old, 'Old sidebar title');
// A deleted bot's home thread: retired, titled with the bot's name.
ids.home = (await load('src/runtime/agent/orchestrator/session/agent-home.mjs')).agentHomeSessionId?.('kestrel') ?? null;
if (ids.home) {
  await _withRegisteredProviderForTestAsync('stub', stub, async () => {
    manager.createSession({ id: ids.home, ...route, owner: 'user', sourceType: 'lead', agent: 'lead', cwd: tasks, desktopSession: { classification: 'task', projectPath: null } });
    await manager.askSession(ids.home, 'hello kestrel', null, undefined, tasks, undefined, {});
  });
  metadata.rememberRetiredTitle(ids.home, 'Kestrel');
  await metadata.setRetired(ids.home, true);
}
await metadata.flush();

// The old product kept a session as one JSON file; the product still reads that shape, so the store holds this one that way.
{
  const sessions = join(data, 'sessions');
  for (const name of readdirSync(sessions)) if (name.startsWith(legacySession.id + '.')) rmSync(join(sessions, name), { force: true });
  writeFileSync(join(sessions, `${legacySession.id}.json`), JSON.stringify(legacySession));
}

// What the desktop's catalog answers over it all.
const rawSessionRows = rawRows();
const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
const rosterOf = (rows) =>
  metadata.withReadCursors(
    metadata.withFavoriteFlags(metadata.withRetiredFlags(metadata.withArchiveFlags(desktopSessionSummaries(rows, metadata.titles, metadata.names, tasks))))
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
  ids,
  roster: jsonSafe(roster),
  overlays,
  forks: [
    { source: ids.stray, heir: ids.forkOfStray, sourceHeader: headerOf(ids.stray), heirHeader: headerOf(ids.forkOfStray) },
    { source: ids.worktree, heir: ids.forkOfWorktree, sourceHeader: headerOf(ids.worktree), heirHeader: headerOf(ids.forkOfWorktree) },
    { source: ids.plain, heir: ids.fork, sourceHeader: headerOf(ids.plain), heirHeader: headerOf(ids.fork) },
    { source: ids.task, heir: ids.forkOfTask, sourceHeader: headerOf(ids.task), heirHeader: headerOf(ids.forkOfTask) },
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
writeSetManifest(out, { set: 'roster-rows', recorder: rel, command: `(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree>`, identity });
console.error(`recorded ${roster.length} roster rows`);
process.exit(0);
