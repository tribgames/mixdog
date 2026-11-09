#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the desktop's idle-only delete (`deleteSessionIfIdle`), for the session
// core's `thread/delete{ifIdle}`: the real service call (`session-action.mjs` `deleteIdleSession` over the real turn
// gate) over the real runtime delete (`session-delete.mjs` `deleteSessionIfIdle` over the real
// session manager, store, ask lock and sidebar host), each reason driven by the situation that
// raises it, in Node's own order.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-delete-idle.mjs --tree <tree> --ref <commit>
// Output: native/core/fixtures/delete-idle/golden.json
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
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
await idleCase('unknown-session', 'runtime', 'no session of that id exists: it has no archive mark', async () => ({
  reply: await service(makeApi())('sess_never_made'),
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
// A turn that is in flight without holding the ask lock (Rust runs a completion wake that way): the archive
// flag is read first, so an unarchived session answers `not-archived`; an archived one is busy.
for (const archived of [false, true]) {
  await idleCase(
    archived ? 'in-flight-archived' : 'in-flight-not-archived',
    'runtime',
    `a turn of the target is in flight and holds no ask lock; the target is ${archived ? '' : 'not '}archived`,
    async (id) => {
      mgr.updateSessionStage(id, 'streaming');
      const reply = await service(makeApi())(id);
      mgr.markSessionDone(id);
      return { reply, untouched: stillThere(id) };
    },
    { archived }
  );
}
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

// --- write ----------------------------------------------------------------------------------------
const rel = 'benchmarks/rust-core/recorders/record-delete-idle.mjs';
const setDir = join(FIXTURES_ROOT, 'delete-idle');
const stage = stageSet(setDir);
writeJson(join(stage, 'golden.json'), { domain: 'delete-idle', recorder: rel, lastUsedAt: LAST_USED, idle: cases });
const command = `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${rel} --tree <tree> --ref <commit>`;
writeSetManifest(stage, { set: 'delete-idle', recorder: rel, command, identityTree: tree, identityRef: args.get('ref') ?? 'HEAD' });
commitStage(stage, setDir);
console.log(`recorded ${cases.length} idle-delete cases`);
releaseHeldSessionWriters();
process.exit(0);
