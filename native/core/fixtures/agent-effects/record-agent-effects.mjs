// Records Node's AgentEffects wiring: the REAL `workflowAgentsApiFor(boot)` of boot/apis.mjs (copied to a temp
// folder with its relative imports made absolute, one `export` appended, and the channel-admin and agent-route
// modules swapped for recording stubs), driven through the agent-admin flow. Runs on temp data/home dirs only.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = 'C:/Project/mixdog/src';
const work = mkdtempSync(join(tmpdir(), 'rec-agent-effects-'));
const dataDir = join(work, 'data');
const home = join(work, 'home');
for (const dir of [dataDir, home, join(work, 'backups'), join(work, 'mods')]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_USER_DATA_BACKUP_ROOT: join(work, 'backups'),
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
});
process.chdir(work);

const log = [];
const rec = (...entry) => log.push(entry);
globalThis.__rec = rec;
globalThis.__owned = [];
globalThis.__ownedFailure = null;
globalThis.__reloadFailure = null;

const stubs = join(work, 'mods');
const stub = (name, text) => {
  const file = join(stubs, name);
  writeFileSync(file, text);
  return pathToFileURL(file).href;
};
const channelAdmin = stub(
  'channel-admin.mjs',
  `export async function deleteOwnedRoutines(agentId) {
  globalThis.__rec('deleteOwnedRoutines', agentId);
  if (globalThis.__ownedFailure) throw globalThis.__ownedFailure;
  return globalThis.__owned.shift() ?? { schedules: [], webhooks: [] };
}`
);
const agentRoute = stub(
  'agent-route.mjs',
  `import { createAgentRouteApi as real } from ${JSON.stringify(pathToFileURL(`${SRC}/session-runtime/workflow-agents-api/agent-route.mjs`).href)};
export function createAgentRouteApi(deps) {
  const api = real(deps);
  return {
    ...api,
    setAgentRoute: async (id, next) => {
      // The second value is what the real setter reads: its first line is \`const requested = { ...(next || {}) }\`.
      globalThis.__rec('setAgentRoute', id, next, { ...(next || {}) });
      return api.setAgentRoute(id, next);
    },
  };
}`
);

// A source file with every relative specifier made absolute (overrides win).
async function load(rel, overrides = {}, append = '') {
  const from = `${SRC}/${rel}`;
  const text = readFileSync(from, 'utf8').replace(/(\b(?:from|import)\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, lead, q, spec) => {
    const abs = resolve(dirname(from), spec).replaceAll('\\', '/');
    const url = overrides[spec] ?? pathToFileURL(abs).href;
    return `${lead}${q}${url}${q}`;
  });
  const out = join(stubs, rel.replaceAll('/', '__'));
  writeFileSync(out, text + append);
  return import(pathToFileURL(out).href);
}

const waApi = await load('session-runtime/workflow-agents-api.mjs', {
  './workflow-agents-api/agent-route.mjs': agentRoute,
});
const waApiUrl = pathToFileURL(join(stubs, 'session-runtime__workflow-agents-api.mjs')).href;
const apis = await load(
  'session-runtime/boot/apis.mjs',
  { '../services/channel-admin.mjs': channelAdmin, '../workflow-agents-api.mjs': waApiUrl },
  '\nexport { workflowAgentsApiFor };\n'
);
void waApi;

const profile = await import(pathToFileURL(`${SRC}/session-runtime/agent-profile-changes.mjs`).href);
profile.subscribeAgentProfileChanges(async () => rec('publishAgentProfileChange'));

const MAIN = { provider: 'anthropic-oauth', model: 'claude-opus-5' };
const rt = {
  config: { workflow: { active: 'default' }, default: 'workflow-lead', agents: {} },
  route: { ...MAIN },
  session: null,
};
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
    reloadChannels: async () => {
      rec('reloadChannels');
      if (globalThis.__reloadFailure) throw globalThis.__reloadFailure;
    },
    reloadChannelsSoon: () => rec('reloadChannelsSoon'),
  },
  { get: (target, key) => (key in target ? target[key] : noop) }
);
const api = apis.workflowAgentsApiFor(boot);

const cases = {};
async function scene(name, run) {
  log.length = 0;
  let result;
  try {
    result = { ok: await run() };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  cases[name] = { result, calls: log.map((entry) => entry.map((item) => structuredClone(item))) };
}

const route = { provider: 'openai', model: 'gpt-6' };
let id;
await scene('save with a route object', async () => {
  const saved = await api.saveAgentDefinition({ name: 'Scout', body: 'Scout.', kind: 'bot', route });
  id = saved.id;
  return { id: saved.id };
});
for (const [label, value] of [
  ['string', 'abc'],
  ['array', ['x', 'y']],
  ['number', 5],
  ['true', true],
  ['empty array', []],
  ['empty string', ''],
]) {
  await scene(`save with a ${label} route`, async () => {
    const saved = await api.saveAgentDefinition({ id, name: 'Scout', body: 'Scout.', route: value });
    return { id: saved.id };
  });
}
await scene('save without a route', async () => api.saveAgentDefinition({ id, name: 'Scout', body: 'Scout 2.' }).then((r) => ({ id: r.id })));
await scene('archive', async () => api.deleteAgentDefinition(id));
await scene('restore', async () => api.restoreAgentDefinition(id).then((r) => ({ id: r.id })));
await scene('restore with a failing reload', async () => {
  await api.deleteAgentDefinition(id);
  globalThis.__reloadFailure = new Error('worker down');
  try {
    return await api.restoreAgentDefinition(id).then((r) => ({ id: r.id }));
  } finally {
    globalThis.__reloadFailure = null;
  }
});
const archived = async (name) => {
  const bot = await api.saveAgentDefinition({ name, body: 'x', kind: 'bot' });
  await api.deleteAgentDefinition(bot.id);
  return bot.id;
};
await scene('purge removing routines', async () => {
  const bot = await archived('Purger');
  log.length = 0;
  globalThis.__owned.push({ schedules: ['mail-review'], webhooks: ['scout-hook'] });
  return api.purgeAgentDefinition(bot);
});
await scene('purge removing nothing', async () => {
  const bot = await archived('Empty');
  log.length = 0;
  return api.purgeAgentDefinition(bot);
});
await scene('purge only webhooks removed', async () => {
  const bot = await archived('Hooker');
  log.length = 0;
  globalThis.__owned.push({ schedules: [], webhooks: ['h'] });
  return api.purgeAgentDefinition(bot);
});
await scene('purge with a failing delete', async () => {
  const bot = await archived('Failing');
  log.length = 0;
  globalThis.__ownedFailure = new Error('connection terminated');
  try {
    return await api.purgeAgentDefinition(bot);
  } finally {
    globalThis.__ownedFailure = null;
  }
});
const stable = JSON.stringify(cases, null, 2);
writeFileSync(process.argv[2] ?? join(work, 'golden.json'), `${stable}\n`);
console.log(stable);
process.exit(0);
