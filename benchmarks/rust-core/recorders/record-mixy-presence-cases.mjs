#!/usr/bin/env node
// Recording of apps/desktop/src/main/mixy-presence.test.mjs (b6f10295a, issue #243): one answer to "does Mixy exist" from every
// reader (the desktop's resolveMixyCreated over the runtime's getLeadStatus route, her heartbeat, her routines' `no-mixy`, the queued
// heartbeat reports' delivery), all from the real runtime over a real profile on disk. Only the row stores of schedules and webhooks
// (and the PostgreSQL cluster probe) are replaced by in-memory rows, as the test did.
//
//   node --experimental-test-module-mocks --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-mixy-presence-cases.mjs --tree <export of b6f10295a with node_modules>
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';

const set = openSet('mixy-presence-cases', import.meta.url);
const { tree } = set;
const root = (path) => pathToFileURL(join(tree, 'src', path)).href;
const rows = { schedules: [], webhooks: [] };
const schedulesDb = await import(root('runtime/channels/lib/schedules-db.mjs'));
mock.module(root('runtime/channels/lib/schedules-db.mjs'), { namedExports: { ...schedulesDb, listSchedules: async () => rows.schedules } });
const webhooksDb = await import(root('runtime/channels/lib/webhooks-db.mjs'));
mock.module(root('runtime/channels/lib/webhooks-db.mjs'), { namedExports: { ...webhooksDb, listEndpoints: async () => rows.webhooks } });
const pgAdapter = await import(root('runtime/memory/lib/pg/adapter.mjs'));
mock.module(root('runtime/memory/lib/pg/adapter.mjs'), { namedExports: { ...pgAdapter, pgClusterExists: () => true } });
const [{ getPluginData }, { createAgentEditorApi }, { createAgentDefinitionApi }, { createMixyHeartbeat }, { createAgentHomeDelivery, createRoutineResultQueue }, { readMixyExists, routineOwnerProblem }, { resolveMixyCreated }] = await Promise.all([
  import(root('runtime/agent/orchestrator/config.mjs')),
  import(root('session-runtime/workflow-agents-api/agent-editor.mjs')),
  import(root('tui/session/session-api/routes-agent-definitions.mjs')),
  import(root('session-runtime/mixy-heartbeat.mjs')),
  import(root('session-runtime/agent-home-delivery.mjs')),
  import(root('session-runtime/routine-owner.mjs')),
  set.load('apps/desktop/src/main/mixy-first.ts'),
]);

const HOME = 'sess_home_lead';
const routes = createAgentDefinitionApi(createAgentEditorApi({ cfgMod: { getPluginData } }));
const dirs = [];
function profile({ manifest = null, thread = null, schedules = [], webhooks = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixy-presence-'));
  dirs.push(dataDir);
  process.env.MIXDOG_DATA_DIR = dataDir;
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
const desktopShows = (dataDir) => routes.getLeadStatus().then((status) => resolveMixyCreated({ status, sessionIds: async () => (existsSync(join(dataDir, 'sessions', `${HOME}.json`)) ? [HOME] : []), setCreated: (created) => routes.setLeadCreated(created) }));
let files = 0;
const fresh = (dataDir, name) => { files += 1; return join(dataDir, `${name}-${files}.json`); };
async function heartbeatRuns(dataDir) {
  const heartbeat = createMixyHeartbeat({ path: fresh(dataDir, 'heartbeat'), isEnabled: async () => true, collect: async () => { throw new Error('a first check only arms'); }, log: () => {} });
  return await heartbeat.tick();
}
async function reportWaits(dataDir) {
  const queue = createRoutineResultQueue(fresh(dataDir, 'routine-results'));
  const delivery = createAgentHomeDelivery({ loadSession: () => null, saveSession: async () => {}, turnInFlight: () => false, queue, live: () => ({ busy: () => false, notice: () => {} }), retryLater: () => {}, mixyExists: () => readMixyExists(), log: () => {} });
  await queue.add(HOME, { runId: 'heartbeat_1', kind: 'agent-message', text: 'Project A got to step 3.', at: 1 });
  await delivery.drain(HOME);
  return await queue.items(HOME);
}
async function answers(dataDir) {
  const before = { heartbeat: await heartbeatRuns(dataDir), routines: await routineOwnerProblem(''), reports: await reportWaits(dataDir) };
  const desktop = await desktopShows(dataDir);
  return { ...before, desktop, desktopAgain: await desktopShows(dataDir), heartbeatAfter: await heartbeatRuns(dataDir) };
}
const profileFiles = (dataDir) => readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dataDir.length + 1));
const manifestOf = (dataDir) => { const p = join(dataDir, 'agents', 'lead', 'agent.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };

const said = (text) => ({ role: 'user', content: text });
const posted = (text) => ({ role: 'assistant', content: text });
const reports = [posted('Project A is building; it got to step 3.'), posted('Project B finished its tests.')];
const mixySchedule = { name: 'daily-news', ownerAgentId: 'lead', enabled: true };
const botSchedule = { name: 'pr-watch', ownerAgentId: 'reviewer', enabled: true };
const CASES = [
  ['created: false is no, whatever else is there', { manifest: { created: false, name: 'Buddy' }, thread: [said('hi')], schedules: [mixySchedule] }],
  ['a name the user set is yes', { manifest: { created: true, name: 'Buddy' } }],
  ['a message the user wrote in her thread is yes', { manifest: { created: true }, thread: [...reports, said('What is B doing?')] }],
  ['a schedule she owns is yes (her thread holds only its results)', { manifest: { created: true }, thread: [posted('Daily news: three items.')], schedules: [mixySchedule] }],
  ['a webhook she owns is yes', { manifest: { created: true }, webhooks: [{ name: 'issues', ownerAgentId: 'lead', enabled: false }] }],
  ["v1.3.0's unnamed automatic Mixy with only heartbeat posts is no (another bot's routine is no evidence)", { manifest: { created: true }, thread: reports, schedules: [botSchedule] }],
  ['an undecided profile is no', {}],
  ['an undecided profile with only heartbeat posts in her thread is no', { thread: reports }],
  ['an undecided profile with a routine she owns is yes, as at v1.3.5', { schedules: [mixySchedule] }],
];
for (const [name, setup] of CASES) {
  await set.run(`one answer everywhere: ${name}`, async () => {
    const dataDir = profile(setup);
    return { setup, answers: await answers(dataDir), leadManifestAfter: manifestOf(dataDir), profileFilesAfter: profileFiles(dataDir) };
  });
}
for (const split of [false, true]) {
  await set.run(`a legacy Mixy with routines stays visible and keeps her heartbeat; without them she is gone everywhere${split ? ' (the bot store split left her in agents/lead)' : ''}`, async () => {
    const setup = { manifest: { created: true }, thread: reports, schedules: [mixySchedule] };
    const dataDir = profile(setup);
    if (split) {
      mkdirSync(join(dataDir, 'bots'), { recursive: true });
      writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: [] }));
    }
    const withRoutine = await answers(dataDir);
    const status = await routes.getLeadStatus();
    rows.schedules = [botSchedule];
    return { setup, botStoreSplit: split, withRoutine, status, leadManifestAfter: manifestOf(dataDir), withoutHerRoutine: await answers(dataDir) };
  });
}
await set.run('an undecided profile is decided once by the desktop, and the decision changes no answer', async () => {
  const dataDir = profile({ thread: reports });
  const log = [];
  log.push({ step: 'undecided', status: await routes.getLeadStatus() });
  log.push({ step: 'desktop shows', shows: await desktopShows(dataDir) });
  log.push({ step: 'after the desktop decided', status: await routes.getLeadStatus(), heartbeat: await heartbeatRuns(dataDir) });
  writeFileSync(join(dataDir, 'sessions', `${HOME}.json`), JSON.stringify({ id: HOME, messages: [...reports, said('hi')] }));
  log.push({ step: 'the user wrote to her', desktop: await desktopShows(dataDir), heartbeat: await heartbeatRuns(dataDir), routineOwnerProblem: await routineOwnerProblem('') });
  return { thread: reports, log, leadManifestAfter: manifestOf(dataDir) };
});

await set.finish({
  entry: {
    runs: "the runtime's createAgentDefinitionApi(createAgentEditorApi) getLeadStatus/setLeadCreated, apps/desktop/src/main/mixy-first.ts resolveMixyCreated, createMixyHeartbeat().tick, createAgentHomeDelivery(...).drain with createRoutineResultQueue, readMixyExists, routineOwnerProblem, each over a real profile on disk (agents/lead/agent.json, sessions/<home>.json)",
    notRun: 'the PostgreSQL row stores: listSchedules, listEndpoints and pgClusterExists are in-memory (as in the test); the heartbeat collect function is never reached',
  },
  replay: { entry: 'mixdog-core run_host heartbeat_parts.rs, home_directory.rs (mixy_exists), routine owner check and the home delivery drain: build the same profile (setup) and compare answers, the lead status, the lead manifest bytes and the profile file list after', normalised: { dataDir: 'a fresh temp data dir per case; profileFilesAfter lists every file in the order readdir returned, with the separators Node produced (backslashes on win32), the per-check state files included' } },
  replaceInText: dirs.map((dir) => [dir, '<data>']),
});
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
process.exit(0);
