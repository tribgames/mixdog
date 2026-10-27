// Issue #243: one answer to "does Mixy exist" — the desktop's (main/mixy-first.ts
// over the runtime's getLeadStatus route), her heartbeat's, her routines'
// (`no-mixy`) and the queued heartbeat reports' — all from the real runtime
// over a real profile on disk. Only the PostgreSQL row stores of schedules and
// webhooks are replaced by in-memory rows.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const root = (path) => new URL(`../../../../src/${path}`, import.meta.url).href;
const rows = { schedules: [], webhooks: [] };
const schedulesDb = await import(root('runtime/channels/lib/schedules-db.mjs'));
mock.module(root('runtime/channels/lib/schedules-db.mjs'), {
  namedExports: { ...schedulesDb, listSchedules: async () => rows.schedules },
});
const webhooksDb = await import(root('runtime/channels/lib/webhooks-db.mjs'));
mock.module(root('runtime/channels/lib/webhooks-db.mjs'), {
  namedExports: { ...webhooksDb, listEndpoints: async () => rows.webhooks },
});
const pgAdapter = await import(root('runtime/memory/lib/pg/adapter.mjs'));
mock.module(root('runtime/memory/lib/pg/adapter.mjs'), {
  namedExports: { ...pgAdapter, pgClusterExists: () => true },
});

const [
  { getPluginData },
  { createAgentEditorApi },
  { createAgentDefinitionApi },
  { createMixyHeartbeat },
  { createAgentHomeDelivery, createRoutineResultQueue },
  { readMixyExists, routineOwnerProblem },
  { resolveMixyCreated },
] = await Promise.all([
  import(root('runtime/agent/orchestrator/config.mjs')),
  import(root('session-runtime/workflow-agents-api/agent-editor.mjs')),
  import(root('tui/session/session-api/routes-agent-definitions.mjs')),
  import(root('session-runtime/mixy-heartbeat.mjs')),
  import(root('session-runtime/agent-home-delivery.mjs')),
  import(root('session-runtime/routine-owner.mjs')),
  import('./mixy-first.ts'),
]);

const HOME = 'sess_home_lead';
// The session route surface the desktop reads (getLeadStatus, setLeadCreated).
const routes = createAgentDefinitionApi(createAgentEditorApi({ cfgMod: { getPluginData } }));

/** A profile in its own data folder: Mixy's agents/lead/agent.json, her
 *  thread's messages, and the stored schedules and webhooks. */
function profile(t, { manifest = null, thread = null, schedules = [], webhooks = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixy-presence-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  if (manifest) {
    mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
    writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (thread) {
    mkdirSync(join(dataDir, 'sessions'), { recursive: true });
    writeFileSync(join(dataDir, 'sessions', `${HOME}.json`), JSON.stringify({ id: HOME, messages: thread }));
  }
  rows.schedules = schedules;
  rows.webhooks = webhooks;
  return dataDir;
}

/** The desktop's answer, as SessionHostLifecycle.leadStatus gets it. */
const desktopShows = (dataDir) =>
  routes.getLeadStatus().then((status) =>
    resolveMixyCreated({
      status,
      sessionIds: async () => (existsSync(join(dataDir, 'sessions', `${HOME}.json`)) ? [HOME] : []),
      setCreated: (created) => routes.setLeadCreated(created),
    })
  );

let files = 0;
/** A state file of its own for each check. */
const fresh = (dataDir, name) => {
  files += 1;
  return join(dataDir, `${name}-${files}.json`);
};

/** Whether a heartbeat check runs: the first one arms; without Mixy, none. */
async function heartbeatRuns(dataDir) {
  const heartbeat = createMixyHeartbeat({
    path: fresh(dataDir, 'heartbeat'),
    isEnabled: async () => true,
    collect: async () => assert.fail('a first check only arms'),
    log: () => {},
  });
  const outcome = await heartbeat.tick();
  assert.ok(['armed', 'no-mixy'].includes(outcome), outcome);
  return outcome === 'armed';
}

/** Whether a queued heartbeat report keeps waiting for her chat (dropped
 *  without her), through the check the daemon's delivery is wired with. */
async function reportWaits(dataDir) {
  const queue = createRoutineResultQueue(fresh(dataDir, 'routine-results'));
  const delivery = createAgentHomeDelivery({
    loadSession: () => null,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue,
    live: () => ({ busy: () => false, notice: () => {} }),
    retryLater: () => {},
    mixyExists: () => readMixyExists(),
    log: () => {},
  });
  await queue.add(HOME, { runId: 'heartbeat_1', kind: 'agent-message', text: 'Project A got to step 3.', at: 1 });
  await delivery.drain(HOME);
  return (await queue.items(HOME)).length === 1;
}

/** Every reader's answer; the desktop's last (it may decide the profile). */
async function answers(dataDir) {
  const before = {
    heartbeat: await heartbeatRuns(dataDir),
    routines: (await routineOwnerProblem('')) === '',
    reports: await reportWaits(dataDir),
  };
  const desktop = await desktopShows(dataDir);
  return {
    ...before,
    desktop,
    // After a decision is persisted: the same answer everywhere.
    desktopAgain: await desktopShows(dataDir),
    heartbeatAfter: await heartbeatRuns(dataDir),
  };
}

const all = (value) => ({
  heartbeat: value,
  routines: value,
  reports: value,
  desktop: value,
  desktopAgain: value,
  heartbeatAfter: value,
});
const said = (text) => ({ role: 'user', content: text });
const posted = (text) => ({ role: 'assistant', content: text });
// What issue #243's user saw: heartbeat reports, posted as Mixy.
const reports = [posted('Project A is building; it got to step 3.'), posted('Project B finished its tests.')];
const mixySchedule = { name: 'daily-news', ownerAgentId: 'lead', enabled: true };
const botSchedule = { name: 'pr-watch', ownerAgentId: 'reviewer', enabled: true };

const CASES = [
  [
    'created: false is no, whatever else is there',
    { manifest: { created: false, name: 'Buddy' }, thread: [said('hi')], schedules: [mixySchedule] },
    false,
  ],
  ['a name the user set is yes', { manifest: { created: true, name: 'Buddy' } }, true],
  [
    'a message the user wrote in her thread is yes',
    { manifest: { created: true }, thread: [...reports, said('What is B doing?')] },
    true,
  ],
  [
    'a schedule she owns is yes (her thread holds only its results)',
    { manifest: { created: true }, thread: [posted('Daily news: three items.')], schedules: [mixySchedule] },
    true,
  ],
  [
    'a webhook she owns is yes',
    { manifest: { created: true }, webhooks: [{ name: 'issues', ownerAgentId: 'lead', enabled: false }] },
    true,
  ],
  [
    "v1.3.0's unnamed automatic Mixy with only heartbeat posts is no (another bot's routine is no evidence)",
    { manifest: { created: true }, thread: reports, schedules: [botSchedule] },
    false,
  ],
  ['an undecided profile is no', {}, false],
  ['an undecided profile with only heartbeat posts in her thread is no', { thread: reports }, false],
  ['an undecided profile with a routine she owns is yes, as at v1.3.5', { schedules: [mixySchedule] }, true],
];

for (const [name, setup, expected] of CASES) {
  test(`one answer everywhere: ${name}`, async (t) => {
    assert.deepEqual(await answers(profile(t, setup)), all(expected));
  });
}

for (const split of [false, true]) {
  test(`a legacy Mixy with routines stays visible and keeps her heartbeat; without them she is gone everywhere${split ? ' (the bot store split left her in agents/lead)' : ''}`, async (t) => {
    const dataDir = profile(t, { manifest: { created: true }, thread: reports, schedules: [mixySchedule] });
    if (split) {
      mkdirSync(join(dataDir, 'bots'), { recursive: true });
      writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: [] }));
    }
    assert.deepEqual(await answers(dataDir), all(true));
    // Nothing is rewritten for her: she stays unnamed and created.
    const status = await routes.getLeadStatus();
    assert.deepEqual([status.created, status.name, status.exists], [true, '', true]);
    // Her last routine deleted, only her posts are left: no evidence.
    rows.schedules = [botSchedule];
    assert.deepEqual(await answers(dataDir), all(false));
  });
}

test('an undecided profile is decided once by the desktop, and the decision changes no answer', async (t) => {
  const dataDir = profile(t, { thread: reports });
  assert.equal((await routes.getLeadStatus()).created, null);
  assert.equal(await desktopShows(dataDir), false);
  // Her thread exists: marked created, as before; still no evidence of her.
  assert.equal((await routes.getLeadStatus()).created, true);
  assert.equal(await heartbeatRuns(dataDir), false);
  // The user writes to her: she exists for every reader.
  writeFileSync(
    join(dataDir, 'sessions', `${HOME}.json`),
    JSON.stringify({ id: HOME, messages: [...reports, said('hi')] })
  );
  assert.equal(await desktopShows(dataDir), true);
  assert.equal(await heartbeatRuns(dataDir), true);
  assert.equal(await routineOwnerProblem(''), '');
});
