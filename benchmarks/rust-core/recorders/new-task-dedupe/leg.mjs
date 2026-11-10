// One process of a Node recording: the real SessionHost (b6f10295a, run unchanged from the export) over a data directory that
// outlives it, with the daemon it talks to scripted by a model that is kept in that directory too (the daemon is a separate process
// in Node: it survives the desktop process that crashes). The model implements only what the host's new-task path uses, each rule
// with the Node source it follows:
//   create     opens or makes the reservation at the address it is given (session-views.mjs:30-64, getOrCreateSessionEntry)
//   submit     one prompt per submission id (session-flow/queue.mjs:20-22, createSubmissionMemory); the first prompt claims the
//              reservation (session-calls/session-turns.mjs:177, `reservedOnly = false`)
//   unsubscribe  an unclaimed reservation is released (session-views.mjs:173-179)
//   read       a session the daemon does not hold is `session <id> is not available`
//   configure  the draft's route, workflow and mode: the route's provider is readied in the real provider registry, which
//              refuses one it does not know with its own error
//
//   node --import tsx leg.mjs <export dir> <scenario dir> <leg json>      (cwd: <export dir>/apps/desktop)
//
// Prints one JSON line per finished step. `crash.at` ends the process (SIGKILL) at a gate: `reserved` / `configured` /
// `accepted` just after the receipt of that phase was renamed into place, `created` once the daemon made the session and before
// its answer to `create` is returned, `submitted` as the daemon's answer to the submit is about to be returned.
import fs, { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asReceived, CONTENTS, CORRUPT } from './scenarios.mjs';

const [exportDir, scenarioDir, legJson] = process.argv.slice(2);
const leg = JSON.parse(legJson);
const userData = join(scenarioDir, 'userData');
const modelFile = join(scenarioDir, 'daemon.json');
const receiptsDir = join(userData, 'new-task-receipts');
process.env.MIXDOG_DATA_DIR = join(scenarioDir, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
mkdirSync(userData, { recursive: true });

const out = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
const die = () => process.kill(process.pid, 'SIGKILL');

// The gate after a receipt is published: the atomic writer renames its temp file over the receipt.
const crashAt = leg.crash?.at;
const afterRename = (to) => {
  if (!crashAt || !String(to).includes('new-task-receipts')) return;
  const phase = JSON.parse(readFileSync(to, 'utf8')).phase;
  if (phase === crashAt && leg.crash.armed) die();
};
const promisesRename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  await promisesRename(from, to);
  afterRename(to);
};
syncBuiltinESMExports();

const load = (path) => import(pathToFileURL(join(exportDir, path)).href);
const { SessionHost } = await load('apps/desktop/src/main/session-host.ts');
const { initProviders } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');

const model = (() => {
  try {
    return JSON.parse(readFileSync(modelFile, 'utf8'));
  } catch {
    return { sessions: {} };
  }
})();
const persist = () => writeFileSync(modelFile, JSON.stringify(model));
let calls = [];
const full = (sessionId) => ({
  sessionId,
  revision: 1,
  full: { sessionId, items: [], queued: [], busy: false, commandBusy: false, provider: 'p', model: 'm', fast: false },
});
const daemon = {
  create: (args) => {
    model.sessions[args.sessionId] ??= { prompts: [], reserved: true };
    // The daemon made the session and the host never gets its answer (the host's process ends while `client.create` is pending).
    if (crashAt === 'created' && leg.crash.armed) {
      persist();
      die();
    }
    return full(args.sessionId);
  },
  submit: (args) => {
    const entry = model.sessions[args.sessionId];
    if (!entry) throw new Error(`session ${args.sessionId} is not available`);
    const submission = args.options?.id;
    if (!entry.prompts.includes(submission)) entry.prompts.push(submission);
    entry.reserved = false;
    persist();
    if (crashAt === 'submitted' && leg.crash.armed) die();
    return { ...full(args.sessionId), accepted: true };
  },
  unsubscribe: (args) => {
    const entry = model.sessions[args.sessionId];
    if (entry?.reserved && entry.prompts.length === 0) delete model.sessions[args.sessionId];
    return {};
  },
  read: (args) => {
    if (!model.sessions[args.sessionId]) throw new Error(`session ${args.sessionId} is not available`);
    return full(args.sessionId);
  },
  configure: async (args) => {
    // The daemon's `setRoute` readies the route's provider in the provider registry before anything else
    // (set-route.mjs:51 `ensureProvidersReady(ensureProviderEnabled(config, provider))`, provider-readiness.mjs:116 `initProviders`):
    // a provider the registry does not know is refused there, with the registry's own error (registry.mjs:223, wrapped at :366,
    // thrown at :383), which reaches the host unchanged (daemon-local-session-bridge.mjs:23-41 passes the rejection on).
    if (args.action === 'setRoute') await initProviders({ [args.args[0].provider]: { enabled: true } });
    return { ...full(args.sessionId), value: args.action === 'setRoute' ? { provider: args.args[0].provider, model: args.args[0].model } : null };
  },
  list: () => ({ sessions: [] }),
};
const client = new Proxy({}, {
  get: (_target, name) => (name === 'then' ? undefined : async (args = {}) => {
    if (name === 'close') return undefined;
    // The catalog list is the host's own background refresh (`void publishCatalogs()`): it lands in whichever step is running.
    if (name !== 'list') calls.push({ method: name, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.action ? { action: args.action } : {}), ...(args.options?.id ? { submission: args.options.id } : {}) });
    const reply = daemon[name];
    if (!reply) throw new Error(`unscripted daemon call ${String(name)}`);
    const answer = await reply(args);
    persist();
    return answer;
  }),
});

const root = realpathSync(scenarioDir);
const runtime = {
  attachSessionClient: async () => client,
  loadProjects: async () => ({ listProjects: () => [], addProject: () => ({}), touchProjectSelected: () => {} }),
  loadSessionStore: async () => ({ listProjects: async () => [] }),
  loadSessionSearch: async () => ({ searchSessionMessages: async () => [] }),
  loadStatuslineSegments: async () => ({}),
  executeCodeGraphTool: async () => ({}),
};
const host = await SessionHost.create({ userDataPath: userData, resourcesPath: root, appPath: root, packaged: false }, runtime);

const receipts = () => {
  try {
    return Object.fromEntries(readdirSync(receiptsDir).sort().map((name) => [name, readFileSync(join(receiptsDir, name)).toString('latin1')]));
  } catch {
    return null;
  }
};
const sessions = () => Object.fromEntries(Object.entries(model.sessions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, entry]) => [id, { prompts: entry.prompts.length, reserved: entry.reserved }]));

const submit = async ({ id, content }) => {
  const { prompt, options, draft } = CONTENTS[content];
  try {
    return asReceived.answer(await host.submitNewTask(prompt, { ...options, id }, structuredClone(draft)));
  } catch (error) {
    return asReceived.rejection(error);
  }
};

for (const entry of leg.steps) {
  const { step, index } = entry;
  calls = [];
  let reply = null;
  if (step.op === 'submit') reply = await submit(step);
  else if (step.op === 'together') reply = await Promise.all(step.calls.map((call) => submit(call)));
  else if (step.op === 'seed') {
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(join(receiptsDir, `${(await import('node:crypto')).createHash('sha256').update(step.id).digest('hex')}.json`), CORRUPT[step.shape]);
  } else if (step.op === 'obstruct') {
    mkdirSync(join(receiptsDir, `${(await import('node:crypto')).createHash('sha256').update(step.id).digest('hex')}.json`), { recursive: true });
  } else if (step.op === 'crash') {
    leg.crash = { ...leg.crash, armed: true };
    await submit(step);
    throw new Error('the process was to end at its gate');
  }
  out({ index, reply, daemonCalls: calls, receipts: receipts(), sessions: sessions() });
}
await host.dispose().catch(() => {});
