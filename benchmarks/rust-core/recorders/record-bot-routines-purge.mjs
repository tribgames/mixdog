#!/usr/bin/env node
// A bot's whole deletion through the admin entry: `deleteAgentDefinition` (archive) then `purgeAgentDefinition` (for
// good) of the REAL `workflowAgentsApiFor(boot)` (session-runtime/boot/apis.mjs, loaded with its relative imports made
// absolute and one `export` appended; nothing swapped), whose `deleteOwnedRoutines` is the real channel-admin over a real
// PostgreSQL store in a temporary data directory. Two bots are saved through the same API; each gets a schedule, a
// webhook with its signing secret and a claimed (queued) delivery through the stores' own writes; the config binds both
// (an agent route and the switched-off list). After every phase the whole state is read: every column webhooks-db.mjs and
// schedules-db.mjs read (the endpoint's secret included), every file under agents/, and the config's agent bindings. The
// stores stamp rows with PostgreSQL's now(); only the seed writes, so every stamp maps to the seed's virtual instant (a
// stamp outside the seed's window fails the recording).
//
//   node benchmarks/rust-core/recorders/record-bot-routines-purge.mjs --tree <exact export of b6f10295a with node_modules> [--out <file>]
//
// Output: native/core/fixtures/bot-routines-purge/golden.json (+ MANIFEST.json).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-bot-routines-purge.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

const work = mkdtempSync(join(SCRATCH, 'purge-')).replaceAll('\\', '/');
const dataDir = `${work}/data`;
const home = `${work}/home`;
const mods = `${work}/mods`;
for (const dir of [dataDir, home, mods]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: work,
  MIXDOG_RUNTIME_ROOT: mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  TZ: 'UTC',
});
process.chdir(work);
const SRC = `${tree.replaceAll('\\', '/')}/src`;
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
// A source file with every relative specifier made absolute, plus `append`.
async function load(rel, append) {
  const from = `${SRC}/${rel}`;
  const text = readFileSync(from, 'utf8').replace(/(\b(?:from|import)\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, lead, q, spec) => `${lead}${q}${pathToFileURL(resolve(dirname(from), spec)).href}${q}`);
  const out = join(mods, rel.replaceAll('/', '__'));
  writeFileSync(out, text + append);
  return import(pathToFileURL(out).href);
}
const apis = await load('session-runtime/boot/apis.mjs', '\nexport { workflowAgentsApiFor };\n');
const schedulesDb = await imp('src/runtime/channels/lib/schedules-db.mjs');
const webhooksDb = await imp('src/runtime/channels/lib/webhooks-db.mjs');
const pgAdapter = await imp('src/runtime/memory/lib/pg/adapter.mjs');

const MAIN = { provider: 'anthropic-oauth', model: 'claude-opus-5' };
const rt = { config: { workflow: { active: 'default' }, default: 'workflow-lead', agents: {} }, route: { ...MAIN }, session: null };
const noop = () => {};
const boot = new Proxy(
  {
    rt,
    cfgMod: { getPluginData: () => dataDir },
    lookupModelMeta: async () => ({}),
    adoptConfig: noop,
    saveConfigAndAdopt: (value) => {
      rt.config = value;
    },
    reloadFullConfig: noop,
    ensureProvidersReady: async () => {},
    displayConfig: () => rt.config,
    invalidateContextStatusCache: noop,
    invalidatePreSessionToolSurface: noop,
    settingsReachCurrentSession: () => false,
    reloadChannels: async () => {},
    reloadChannelsSoon: noop,
  },
  { get: (target, key) => (key in target ? target[key] : noop) }
);
const api = apis.workflowAgentsApiFor(boot);

const VIRTUAL_START = 1_700_000_000_000;
const VIRTUAL_STEP = 1_000;
const windows = [];
async function phase(run) {
  const opened = Date.now();
  let outcome;
  try {
    outcome = { reply: await run() };
  } catch (error) {
    outcome = { error: String(error?.message ?? error) };
  }
  windows.push([opened, Date.now()]);
  return outcome;
}
// Only the seed writes rows (the deletion phases only remove them), so every stamp is the seed's: it must lie in the
// seed's window, widened by the skew allowed between PostgreSQL's clock and this process's (1 s), and maps to phase 0.
const SKEW = 1_000;
const virtual = (stamp) => {
  if (stamp == null) return null;
  const at = new Date(stamp).getTime();
  const [from, to] = windows[0];
  if (at < from - SKEW || at > to + SKEW) throw new Error(`stamp ${new Date(stamp).toISOString()} lies outside the seed's window`);
  return new Date(VIRTUAL_START).toISOString();
};

const seed = {
  bots: [
    { name: 'GH Bot', body: 'I triage GitHub.', kind: 'bot' },
    { name: 'Other Bot', body: 'I am the other one.', kind: 'bot' },
  ],
  config: { agents: { route: { provider: 'openai', model: 'gpt-6' } }, disabledAgents: true },
  schedules: [
    { name: 'daily-mine', prompt: 'Check the build', whenCron: '0 9 * * *', timezone: 'UTC', owner: 0 },
    { name: 'daily-theirs', prompt: 'Check the build', whenCron: '0 9 * * *', timezone: 'UTC', owner: 1 },
  ],
  endpoints: [
    { name: 'hook-mine', instructions: 'Triage.', secret: 's3cret-mine', owner: 0 },
    { name: 'hook-theirs', instructions: 'Triage.', secret: 's3cret-theirs', owner: 1 },
  ],
  deliveries: [
    { endpoint: 'hook-mine', deliveryId: 'delivery-mine' },
    { endpoint: 'hook-theirs', deliveryId: 'delivery-theirs' },
  ],
  claim: { status: 'pending', event: 'issues', headersSummary: { 'x-github-event': 'issues' }, payloadPreview: '{"action":"opened"}' },
};
let ids;
const seeded = await phase(async () => {
  ids = [];
  for (const bot of seed.bots) ids.push((await api.saveAgentDefinition(bot)).id);
  const [mine, theirs] = ids;
  // The config binds both bots: an agent route each, and both switched off.
  rt.config = { ...rt.config, agents: { [mine]: seed.config.agents.route, [theirs]: seed.config.agents.route }, disabledAgents: [mine, theirs] };
  // `owner` is the index of the saved bot that owns the row.
  for (const { owner, ...def } of seed.schedules) await schedulesDb.upsertSchedule({ ...def, ownerAgentId: ids[owner] });
  for (const { owner, ...def } of seed.endpoints) await webhooksDb.upsertEndpoint({ ...def, ownerAgentId: ids[owner] });
  // Claimed as the receiver claims a delivery it queues (request-handler.mjs: status, event, headers, preview).
  for (const { endpoint, deliveryId } of seed.deliveries) await webhooksDb.claimDelivery(endpoint, deliveryId, seed.claim);
  return ids;
});

const db = await schedulesDb.openSchedulesDb();
const SCHEDULE_COLS =
  'name, description, when_at, when_cron, timezone, cwd, attachments, delivery, prompt, enabled, status, last_fired_at, last_scheduled_at, last_started_at, last_success_at, last_failed_at, last_skipped_at, owner_agent_id, executor_agent_id, consecutive_failures, result_delivery, next_fire_at, deferred_until, skipped_until, created_at, updated_at';
const ENDPOINT_COLS =
  'name, description, parser, secret, cwd, attachments, delivery, instructions, enabled, owner_agent_id, executor_agent_id, last_event_at, last_success_at, last_failed_at, last_skipped_at, consecutive_failures, result_delivery, (last_payload IS NOT NULL) AS has_last_payload, created_at, updated_at';
const DELIVERY_COLS = 'endpoint, delivery_id, status, event, error, headers_summary, payload_preview, created_at, updated_at';
const STAMPS = new Set(['when_at', 'last_fired_at', 'last_scheduled_at', 'last_started_at', 'last_success_at', 'last_failed_at', 'last_skipped_at', 'next_fire_at', 'deferred_until', 'skipped_until', 'last_event_at', 'created_at', 'updated_at']);
const rows = async (sql) => (await db.query(sql)).rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, STAMPS.has(k) ? virtual(v) : v])));
const files = (root) => {
  if (!existsSync(root)) return {};
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
};
const state = async () => ({
  schedules: await rows(`SELECT ${SCHEDULE_COLS} FROM scheduler.schedules ORDER BY name`),
  endpoints: await rows(`SELECT ${ENDPOINT_COLS} FROM webhooks.endpoints ORDER BY name`),
  deliveries: await rows(`SELECT ${DELIVERY_COLS} FROM webhooks.deliveries ORDER BY endpoint, delivery_id`),
  agents: files(join(dataDir, 'agents')),
  config: { agents: rt.config.agents ?? null, disabledAgents: rt.config.disabledAgents ?? null },
});

const [mine] = ids;
const result = { seed, virtualClock: { start: VIRTUAL_START, step: VIRTUAL_STEP }, saved: seeded, phases: [] };
const snapshots = [{ step: 'seeded', state: await state() }];
for (const [step, run] of [
  ['deleteAgentDefinition', () => api.deleteAgentDefinition(mine)],
  ['purgeAgentDefinition', () => api.purgeAgentDefinition(mine)],
  ['purgeAgentDefinition again', () => api.purgeAgentDefinition(mine)],
]) {
  const outcome = await phase(run);
  snapshots.push({ step, agentId: mine, ...outcome, state: await state() });
}
result.phases = snapshots;

const out = args.get('out');
if (out) {
  writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'bot-routines-purge');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'bot-routines-purge',
    recorder,
    command: `node ${recorder} --tree <exact export of b6f10295a with node_modules>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      columns: 'every column schedules-db.mjs (COLS), webhooks-db.mjs (ENDPOINT_COLS, DELIVERY_COLS) read; stamps on the virtual clock (phase i at start + i * step)',
    },
  });
  commitStage(stage, finalDir);
}
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
