#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the desktop's idle-only delete (`deleteSessionIfIdle`) and of its
// "move to project" refusals, for the session core's `thread/delete{ifIdle}` and
// `thread/metadata/update{projectPath}`.
//
// Idle delete: the real service call (`session-action.mjs` `deleteIdleSession` over the real turn
// gate) over the real runtime delete (`session-delete.mjs` `deleteSessionIfIdle` over the real
// session manager, store, ask lock and sidebar host), each reason driven by the situation that
// raises it, in Node's own order. Project move: the real `SessionHost` lifecycle
// `setSessionProject` over rows and live states of the situations that refuse it.
//
//   node --import <resolver for the tree's TS sources and packages> \
//        <repo>/benchmarks/rust-core/recorders/record-delete-idle.mjs --tree <tree>
// Output: native/core/fixtures/delete-idle/golden.json
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'delete-idle-'));

// An isolated environment, set before anything of the product loads.
const dirs = { data: join(root, 'data'), home: join(root, 'home'), appdata: join(root, 'appdata'), local: join(root, 'local') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
mkdirSync(join(dirs.data, 'sessions'));
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.local,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
});

const { createSessionSwitching } = await importFrom(tree, 'src/session-runtime/lifecycle/session-switch.mjs');
const mgr = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager.mjs');
const { cancelBackgroundTasks } = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { registerSessionSidebarHost } = await importFrom(tree, 'src/runtime/shared/session-sidebar-host.mjs');
const { acquireSessionLock } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/session-lock.mjs');
const { holdTurnUntilDurable, forgetUnsettledTurn } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/manager/turn-durability.mjs'
);
const { enqueuePendingMessage } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const { _sessionSummary, _writeSummaryIndex, settleSummaryIndexWrites } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/store-summary-index.mjs'
);
const { createSessionActionCalls } = await importFrom(tree, 'src/standalone/session-service/session-calls/session-action.mjs');
const { createSessionTurnGate } = await importFrom(tree, 'src/standalone/session-service/session-calls/turn-gate.mjs');
const { createBusyTracker } = await importFrom(tree, 'src/standalone/session-service/retention/busy.mjs');
const { releaseHeldSessionWriters } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'
);
const { readDurableSessionRecord } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/store/transcript-durability.mjs'
);

// --- the idle delete ------------------------------------------------------------------------------
const fileOf = (id) => join(dirs.data, 'sessions', `${id}.json`);
const LAST_USED = 50;
const record = (id) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  updatedAt: 10,
  lastUsedAt: LAST_USED,
  messages: [{ role: 'user', content: `hello ${id}` }],
});

let sidebar = { archived: {}, favorites: {} };
let onState = async () => {};
registerSessionSidebarHost(async () => {}, {
  state: async () => {
    await onState();
    return { archived: sidebar.archived, favorites: sidebar.favorites };
  },
});

async function seed(id) {
  await settleSummaryIndexWrites();
  writeFileSync(fileOf(id), JSON.stringify(record(id)));
  await _writeSummaryIndex([_sessionSummary(record(id))].filter(Boolean));
}

function makeApi({ currentId = 'someone_else', getSession = null } = {}) {
  return createSessionSwitching(
    {
      getSession: getSession ?? (() => ({ id: currentId, messages: [] })),
      setSession: () => {},
      getAddressedSessionId: () => currentId,
      markAddressTerminal: () => {},
      invalidateContextStatusCache: () => {},
      invalidatePreSessionToolSurface: () => {},
      mgr,
      statusRoutes: { clearGatewaySessionRoute: () => {} },
      agentTool: { closeAll: () => {} },
      cleanupDeletedSessionWorktree: async () => {},
    },
    { ingestSessionIntoMemory: async () => {}, closeSurfaceSession: () => {}, cancelBackgroundTasks }
  );
}

const { stateBusy } = createBusyTracker({ sessions: [], currentSessionId: () => '' });
const gate = createSessionTurnGate();

/** The service call the desktop makes through its control session: `args` = [target, expected]. */
function service(api, { owner = null } = {}) {
  const entry = { runtime: api };
  const calls = createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    turnGate: gate,
    projection: { bodyForClient: () => ({}), sessionOwner: () => owner },
    retention: {
      retainUnwatched() {},
      awaitingApprovalSessionKinds: () => new Map(),
      roomHandoffQuestions: () => new Map(),
      stateBusy,
    },
    entries: {
      assertAvailable() {},
      hostedEntryForSession: async () => entry,
      entryForSession: async () => entry,
      settleTeardown: async () => {},
    },
    advanceForCaller: () => ({}),
    responseSessionId: (_entry, id) => id,
  });
  return async (target, expected = { lastUsedAt: LAST_USED }) =>
    (await calls.configureSession({ sessionId: 'sess_control', action: 'deleteSessionIfIdle', args: [target, expected] })).value;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const cases = [];
let counter = 0;
/** One case: a fresh archived session, `run` drives the situation and answers what Node replied. */
async function idleCase(name, layer, note, run, { archived = true } = {}) {
  const id = `sess_idle_${(counter += 1)}`;
  await seed(id);
  sidebar = { archived: archived ? { [id]: 1 } : {}, favorites: {} };
  onState = async () => {};
  const out = await run(id);
  cases.push({ name, layer, note, ...out });
  onState = async () => {};
}
const stillThere = (id) => {
  const stored = readDurableSessionRecord(id);
  return stored?.closed === false && stored.generation === 0;
};

// The service: no target, then the turn gate.
await idleCase('no-target', 'service', 'the control call names no session', async () => ({
  reply: await service(makeApi())(''),
}));
await idleCase('bad-id', 'runtime', 'the target is not a session id', async () => ({
  reply: await service(makeApi())('bad id'),
}));
await idleCase('turn-starting-admitted', 'service', 'a turn start of the target is being admitted', async (id) => {
  const leave = gate.enter(id);
  const reply = await service(makeApi())(id, { lastUsedAt: LAST_USED - 1 });
  leave();
  return { reply, afterwards: await service(makeApi())(id, { lastUsedAt: LAST_USED - 1 }) };
});
await idleCase('turn-starting-fenced', 'service', 'another idle delete of the target is running', async (id) => {
  const entered = deferred();
  const release = deferred();
  onState = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = service(makeApi())(id, { lastUsedAt: LAST_USED - 1 });
  await entered.promise;
  const reply = await service(makeApi())(id, { lastUsedAt: LAST_USED - 1 });
  let start = null;
  try {
    gate.enter(id)();
  } catch (error) {
    start = { error: error.name, message: error.message };
  }
  release.resolve();
  return { reply, firstReply: await first, startWhileFenced: start };
});

// The runtime: the guard, the current session, the ask lock, the sidebar flags.
await idleCase('unguarded', 'runtime', 'the caller gives no isHostedBusy guard', async (id) => ({
  reply: await makeApi().deleteSessionIfIdle(id, { lastUsedAt: LAST_USED }),
}));
await idleCase('current', 'runtime', 'the target is the session the runtime has current', async (id) => ({
  reply: await service(makeApi({ currentId: id }))(id),
}));
for (const archived of [false, true]) {
  await idleCase(
    archived ? 'busy-lock-archived' : 'busy-lock-not-archived',
    'runtime',
    `a turn holds the target's ask lock; the target is ${archived ? '' : 'not '}archived`,
    async (id) => {
      const unlock = await acquireSessionLock(id);
      const reply = await service(makeApi())(id);
      unlock();
      return { reply };
    },
    { archived }
  );
}
await idleCase('not-archived', 'runtime', 'the target is not archived', async (id) => ({
  reply: await service(makeApi())(id),
}), { archived: false });
await idleCase('favorite', 'runtime', 'the target is archived and a favorite', async (id) => {
  sidebar.favorites = { [id]: 1 };
  return { reply: await service(makeApi())(id) };
});

// The idle checks, after the flags.
await idleCase('turn-waiting', 'runtime', 'a turn reaches the ask lock while the archive flag is read', async (id) => {
  let turn = null;
  onState = async () => {
    turn ??= acquireSessionLock(id);
  };
  const reply = await service(makeApi())(id);
  (await turn)();
  return { reply, untouched: stillThere(id) };
});
await idleCase('busy-unsettled', 'runtime', 'a turn of the target is not yet durable', async (id) => {
  holdTurnUntilDurable({ sessionId: id, session: { id }, turnToken: 'turn_1', generation: 0, save: new Promise(() => {}) });
  const reply = await service(makeApi())(id);
  forgetUnsettledTurn(id);
  return { reply, untouched: stillThere(id) };
});
await idleCase('queued-pending', 'runtime', 'input waits in the target\'s pending queue', async (id) => {
  enqueuePendingMessage(id, 'typed');
  return { reply: await service(makeApi())(id), untouched: stillThere(id) };
});
await idleCase('queued-hosted', 'runtime', 'a runtime hosting the target holds queued input', async (id) => {
  const owner = { runtime: { getState: () => ({ queued: ['typed'] }) } };
  return { reply: await service(makeApi(), { owner })(id), untouched: stillThere(id) };
});
await idleCase('missing', 'runtime', 'the target\'s record is gone when the checks run', async (id) => {
  onState = async () => rmSync(fileOf(id));
  return { reply: await service(makeApi())(id) };
});
await idleCase('changed', 'runtime', 'the target moved since the caller looked', async (id) => ({
  reply: await service(makeApi())(id, { lastUsedAt: LAST_USED - 1 }),
  untouched: stillThere(id),
}));

// The close: another process is the session's writer, so the close barrier cannot land.
await idleCase('close-failed', 'runtime', 'the close cannot land: another process holds the session\'s writer claim', async (id) => {
  const holder = spawn(
    process.execPath,
    [
      ...process.execArgv,
      '--input-type=module',
      '-e',
      `const { claimSessionWriter } = await import(${JSON.stringify(new URL(
        'src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs',
        `file:///${tree.replaceAll('\\', '/')}/`
      ).href)}); console.log(claimSessionWriter(${JSON.stringify(id)}).held ? 'held' : 'refused'); process.stdin.resume();`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env: process.env }
  );
  const first = await new Promise((resolve, reject) => {
    holder.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    holder.once('error', reject);
    holder.once('exit', () => reject(new Error('the claim holder exited')));
  });
  if (first !== 'held') throw new Error(`the claim holder got ${first}`);
  try {
    return { reply: await service(makeApi())(id), untouched: stillThere(id) };
  } finally {
    holder.stdin.end();
  }
});
await idleCase('deleted', 'runtime', 'archived, not a favorite, idle and unchanged', async (id) => ({
  reply: await service(makeApi())(id),
  gone: !existsSync(fileOf(id)),
}));

// --- the project move -----------------------------------------------------------------------------
const { SessionHost } = await importFrom(tree, 'apps/desktop/src/main/session-host.ts');

const project = join(root, 'repo');
const worktree = join(root, 'data', 'worktrees-v1', '0123456789abcdef', 'fix-login');
const elsewhere = join(root, 'elsewhere');
for (const dir of [project, worktree, elsewhere]) mkdirSync(dir, { recursive: true });
const host = await SessionHost.create(
  { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
  {
    attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => {} }),
    loadProjects: async () => ({
      listProjects: () => [{ name: 'repo', path: project, addedAt: 1 }],
      listProjectsStrict: () => [{ name: 'repo', path: project, addedAt: 1 }],
    }),
    loadWorktrees: async () => ({ getWorktreeByPath: () => null }),
    loadSessionStore: async () => ({}),
    loadStatuslineSegments: async () => ({}),
    executeCodeGraphTool: async () => ({}),
  }
);
const invoked = [];
host.transport.invokeSession = async (sessionId, method, args) => {
  invoked.push([sessionId, method, args]);
  return { value: args[0], snapshot: null, result: {} };
};
host.catalog.publishCatalogs = async () => {};
const task = join(root, 'workspace', 'unclassified');

// Where a session works, and what a target names, by the names the fixture uses.
const WHERE = {
  task: { cwd: elsewhere, projectPath: null },
  project: { cwd: join(project, 'src'), projectPath: project },
  worktree: {
    cwd: worktree,
    projectPath: project,
    workspace: { projectPath: project, cwd: worktree, worktreeId: 'fix-login' },
  },
};
const TARGET = { project, task: '', elsewhere };
const named = (cwd) => (cwd === project ? 'project' : cwd === task ? 'task' : cwd);

const moves = [];
/** One move: where the session works, the catalog's `leadWorking`, the live snapshot the host
 *  holds, and the target. The outcome is the runtime's `setCwd` it made, or the refusal's text. */
async function move(name, note, { where, working = false, live = null, target, listed = true }) {
  const id = `sess_move_${moves.length + 1}`;
  const row = { id, ...WHERE[where], ...(working ? { working: true, leadWorking: true } : {}) };
  host.listSessions = async () => (listed ? [row] : []);
  host.publication.projections.delete(id);
  if (live) host.publication.projections.set(id, { snapshot: live });
  const before = invoked.length;
  let outcome;
  try {
    await host.setSessionProject(id, TARGET[target]);
    outcome = { moved: invoked.slice(before).map(([, method, args]) => ({ method, cwd: named(args[0]) })) };
  } catch (error) {
    outcome = { error: error.message };
  }
  moves.push({ name, note, listed, where, working, live, target, ...outcome });
}
await move('moves-into-project', 'an idle task session moves into a registered Project', { where: 'task', target: 'project' });
await move('moves-to-task', 'an idle Project session moves out to the task workspace', { where: 'project', target: 'task' });
await move('already-there', 'a session already in that Project stays put', { where: 'project', target: 'project' });
await move('already-task', 'a task session asked for "no Project" stays put', { where: 'task', target: 'task' });
await move('unlisted', 'the catalog does not list the session', { where: 'task', target: 'project', listed: false });
await move('not-registered', 'the target is not a registered Project', { where: 'task', target: 'elsewhere' });
await move('lead-working', 'the catalog row says the session\'s own turn is in flight', {
  where: 'task',
  working: true,
  target: 'project',
});
await move('live-busy', 'the live state is busy', { where: 'task', live: { busy: true }, target: 'project' });
await move('live-command-busy', 'a compaction is running', { where: 'task', live: { commandBusy: true }, target: 'project' });
await move('live-idle', 'a live state that is neither busy nor running a command', {
  where: 'task',
  live: { busy: false, commandBusy: false },
  target: 'project',
});
await move('worktree', 'the session works in a managed worktree', { where: 'worktree', target: 'task' });
await move('busy-before-worktree', 'a busy session in a worktree is refused for the turn first', {
  where: 'worktree',
  working: true,
  target: 'task',
});
await move('same-project-while-busy', 'a busy session already in that Project is not refused', {
  where: 'project',
  working: true,
  target: 'project',
});

// --- write ----------------------------------------------------------------------------------------
const rel = 'benchmarks/rust-core/recorders/record-delete-idle.mjs';
const setDir = join(FIXTURES_ROOT, 'delete-idle');
writeJson(join(setDir, 'golden.json'), {
  domain: 'delete-idle',
  recorder: rel,
  lastUsedAt: LAST_USED,
  idle: cases,
  moves,
});
const command = `node --import <resolver for the tree's TS sources and packages> <repo>/${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'delete-idle', recorder: rel, command });
console.log(`recorded ${cases.length} idle-delete cases, ${moves.length} project moves`);
releaseHeldSessionWriters();
await host.dispose().catch(() => {});
process.exit(0);
