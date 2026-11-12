#!/usr/bin/env node
// Recording of apps/desktop/src/main/project-recency-failure.test.mjs (b6f10295a): the desktop's project registry when only the
// recency write fails (a real rename failure injected on the registry file), a failure of the registry read, and a corrupt registry.
// Real SessionHost (session-host.ts) and DesktopProjectRegistry over the real shared/projects.mjs (a fresh instance per case, its
// MIXDOG_PROJECTS_FILE pointing at the case's temp registry); the daemon client is scripted (create/submit/unsubscribe counters).
// The parametrised Node tests (submission x {publication, corrupt registry}; explicit {add,enter,rename,remove,touch}) are recorded as
// one case each with a list of runs, the case names being the Node test names with the ${…} template. Every temp root is written <root> wherever it occurs (listed in the manifest's normalised.paths); the separators are those Node produced (backslashes on win32), also inside a registry file's JSON text, where they are doubled.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-project-recency-failure-cases.mjs --tree <export of b6f10295a with node_modules>
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';
import { pathToFileURL } from 'node:url';

const set = openSet('project-recency-failure-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const { SessionHost } = await set.load('apps/desktop/src/main/session-host.ts');
const { DesktopProjectRegistry } = await set.load('apps/desktop/src/main/desktop-project-registry.ts');
const { makeTempDirSync } = await set.load('scripts/lib/scoped-temp.mjs');
const PROJECTS_URL = pathToFileURL(join(tree, 'src/runtime/shared/projects.mjs')).href;
let sequence = 0;
const roots = [];

async function fixture() {
  const root = await fs.promises.realpath(makeTempDirSync('project-recency'));
  roots.push(root);
  const project = join(root, 'project');
  const file = join(root, 'projects.json');
  fs.mkdirSync(project);
  const original = JSON.stringify({ projects: [{ path: project, name: 'project', addedAt: 1 }] });
  fs.writeFileSync(file, original);
  const saved = process.env.MIXDOG_PROJECTS_FILE;
  process.env.MIXDOG_PROJECTS_FILE = file;
  let store;
  try { store = await import(`${PROJECTS_URL}?recency=${sequence++}`); } finally { if (saved === undefined) delete process.env.MIXDOG_PROJECTS_FILE; else process.env.MIXDOG_PROJECTS_FILE = saved; }
  let sessionId = '';
  const calls = { creates: 0, submits: 0, unsubscribes: 0 };
  const snapshot = () => ({ sessionId, items: [], queued: [], cwd: project, currentProject: project });
  const client = {
    list: async () => ({ sessions: [] }),
    async create(params) { calls.creates++; sessionId = params.sessionId; return { sessionId, revision: 0, full: snapshot() }; },
    async submit() { calls.submits++; return { sessionId, accepted: true, revision: 1, full: snapshot() }; },
    read: async () => ({ sessionId, revision: 1, full: snapshot() }),
    async unsubscribe() { calls.unsubscribes++; return {}; },
    close: async () => {},
  };
  const host = await SessionHost.create({ userDataPath: root, resourcesPath: root, appPath: root, packaged: false }, { attachSessionClient: async () => client, loadProjects: async () => store, loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }), loadStatuslineSegments: async () => ({}), executeCodeGraphTool: async () => ({}) });
  const registry = new DesktopProjectRegistry({ loadProjectsModule: async () => store, userDataRoot: () => root });
  const patched = [];
  const patch = (name, fn) => { patched.push([name, fs[name]]); fs[name] = fn; syncBuiltinESMExports(); };
  const cleanup = async () => { for (const [name, original] of patched.reverse()) fs[name] = original; syncBuiltinESMExports(); await new Promise((r) => setImmediate(r)); await host.dispose(); fs.rmSync(root, { recursive: true, force: true }); };
  /** Every rename that publishes the registry file throws this one error. */
  const failRegistryPublication = () => {
    const err = Object.assign(new Error('registry publication failed'), { code: 'EIO' });
    const rename = fs.renameSync;
    let attempts = 0;
    patch('renameSync', (from, to, ...args) => { if (to === file) { attempts++; throw err; } return rename(from, to, ...args); });
    return { failure: err, attempts: () => attempts };
  };
  return { root, project, file, original, store, registry, host, calls, client, patch, failRegistryPublication, cleanup };
}
const withFixture = async (fn) => { const f = await fixture(); try { return await fn(f); } finally { await f.cleanup(); } };

await set.run('startProjectTask opens and publishes its shell despite a real recency publication failure', () => withFixture(async (f) => {
  const failed = f.failRegistryPublication();
  const snapshot = await f.host.startProjectTask(f.project);
  return ({ snapshot, hostSnapshot: f.host.getSnapshot(), renameAttempts: failed.attempts(), registryFile: fs.readFileSync(f.file, 'utf8'), originalRegistry: f.original });
}));

await set.run('an accepted submission commits its receipt and stays subscribed after ${cause} breaks recency', async () => {
  const runs = [];
  for (const cause of ['publication', 'corrupt registry']) {
    runs.push(await withFixture(async (f) => {
      if (cause === 'publication') f.failRegistryPublication();
      else { const submit = f.client.submit; f.client.submit = async (...args) => { const result = await submit(...args); fs.writeFileSync(f.file, '{broken'); return result; }; }
      const options = { id: `recency-submit-${cause}` };
      const draft = { projectPath: f.project };
      const result = await f.host.submitNewTask('accepted work', options, draft);
      const key = createHash('sha256').update(options.id).digest('hex');
      const receipt = JSON.parse(fs.readFileSync(join(f.root, 'new-task-receipts', `${key}.json`), 'utf8'));
      const retry = await f.host.submitNewTask('accepted work', options, draft);
      return ({ cause, options, draft, result, receipt, retry, calls: f.calls });
    }));
  }
  return { runs };
});

await set.run('enter keeps registration and unhiding when only the recency write fails', () => withFixture(async (f) => {
  fs.writeFileSync(join(f.root, 'desktop-projects.json'), JSON.stringify({ version: 2, hidden: [f.project], aliases: {} }));
  const failed = f.failRegistryPublication();
  const entered = await f.registry.enter(f.project);
  return ({ startFiles: { 'desktop-projects.json': { version: 2, hidden: [f.project], aliases: {} } }, entered, renameAttempts: failed.attempts(), desktopProjectsAfter: fs.readFileSync(join(f.root, 'desktop-projects.json'), 'utf8'), knownPath: await f.registry.knownPath(f.project), project: f.project });
}));

await set.run('explicit ${action} still rejects the original registry persistence error', async () => {
  const runs = [];
  for (const action of ['add', 'enter', 'rename', 'remove', 'touch']) {
    runs.push(await withFixture(async (f) => {
      const newPath = join(f.root, 'new-project');
      fs.mkdirSync(newPath);
      const failed = f.failRegistryPublication();
      const run = { add: () => f.host.addProject(newPath), enter: () => f.host.startProject(newPath), rename: () => f.host.renameProject(f.project, 'renamed'), remove: () => f.host.removeProject(f.project), touch: () => f.registry.touchSelected(f.project) }[action];
      let outcome;
      try { await run(); outcome = { rejected: false }; } catch (e) { outcome = { rejected: true, isTheOriginalError: e === failed.failure, error: e }; }
      return ({ action, ...outcome, renameAttempts: failed.attempts(), registryFile: fs.readFileSync(f.file, 'utf8'), originalRegistry: f.original, hostSnapshot: f.host.getSnapshot() });
    }));
  }
  return { runs };
});

await set.run('registration and project-authority failures are not swallowed as recency failures', () => withFixture(async (f) => {
  const err = Object.assign(new Error('registry unreadable'), { code: 'EIO' });
  const read = fs.readFileSync;
  f.patch('readFileSync', (file, ...args) => { if (file === f.file) throw err; return read(file, ...args); });
  const attempt = async (fn) => { try { await fn(); return { rejected: false }; } catch (e) { return { rejected: true, isTheOriginalError: e === err, error: e }; } };
  const results = { startProject: await attempt(() => f.host.startProject(f.project)), startProjectTask: await attempt(() => f.host.startProjectTask(f.project)), submitNewTask: await attempt(() => f.host.submitNewTask('must not start', { id: 'bad-registry' }, { projectPath: f.project })) };
  const calls = { ...f.calls };
  fs.readFileSync = read; syncBuiltinESMExports();
  return ({ injected: err, results, calls, registryFile: fs.readFileSync(f.file, 'utf8'), originalRegistry: f.original });
}));

await set.run('a corrupt registry is recovered: its bytes are kept aside and project start still works', () => withFixture(async (f) => {
  fs.writeFileSync(f.file, '{broken');
  let first;
  try { await f.host.startProjectTask(f.project); first = { rejected: false }; } catch (e) { first = { rejected: true, error: e, isSyntaxError: e instanceof SyntaxError }; }
  await f.host.addProject(f.project);
  const snapshot = await f.host.startProjectTask(f.project);
  const asides = fs.readdirSync(f.root).filter((name) => name.startsWith('projects.json.corrupt-'));
  return ({ registryBytes: '{broken', firstStart: first, snapshot, project: f.project, asides, asideBytes: asides.map((name) => fs.readFileSync(join(f.root, name), 'utf8')) });
}));

await set.finish({
  entry: { runs: 'apps/desktop SessionHost + DesktopProjectRegistry over shared/projects.mjs with a scripted daemon client; fs.renameSync / fs.readFileSync patched to fail on the registry file', notRun: 'no daemon, no Electron' },
  replay: { entry: 'mixdog-store registry.rs (+ app-server host): a failing recency write must not fail enter/start/submit, explicit registry changes still reject the original error, a corrupt registry is kept aside', normalised: { dataDir: '<root>, wherever it occurs; separators as Node produced them (backslashes on win32, doubled inside JSON text)' } },
  exclusions: {
    '$.cases[1].observed.runs[1]': 'the corrupt-registry cause, not replayable until a boot behaviour is decided: the core refuses to start on a corrupt core state where Node sets the registry aside and starts empty. Node, finding projects.json unparsable, moves it to projects.json.corrupt-<ts>, starts an empty registry and carries on (the task is accepted, the recency write is a successful no-op). The core keeps the registry in state/core.sqlite; a core state it cannot open aborts composition (mixdog-app-server-daemon compose.rs CoreState::open, ComposeError::State; mixdog-store sqlite.rs open_schema, DbError::Rebuild), so the daemon does not start, nothing is set aside and nothing is replaced. Product difference, open (owner: the daemon\'s compose step)',
    '$.cases[1].observed.runs[*].{result,retry}.snapshot.items': 'the desktop host\'s transcript items of the session; the core answers the thread summary, which carries no transcript (owner: the host-side snapshot, desktop SessionHost)',
    '$.cases[1].observed.runs[*].{result,retry}.snapshot.queued': 'the desktop host\'s queued submissions of the session; the core answers no queue in the thread summary (owner: the host-side snapshot, desktop SessionHost)',
    '$.cases[1].observed.runs[*].{result,retry}.snapshot.remoteEnabled': 'the desktop host\'s remote-control flag; the core\'s thread summary has no counterpart (owner: the host-side snapshot, desktop SessionHost)',
    '$.cases[1].observed.runs[*].{result,retry}.snapshot.remoteSessionId': 'the desktop host\'s remote session id; the core\'s thread summary has no counterpart (owner: the host-side snapshot, desktop SessionHost)',
  },
  replaceInText: roots.map((r) => [r, '<root>']),
  replaceRegex: [[/^[0-9a-f]{64}$/, '<sha256 of the per-run project path>']],
  normaliseReason: 'per-run temp root written <root>; the receipt signature is a sha256 over the per-run project path, written <sha256 of the per-run project path> (only the strings that are exactly 64 hex digits)',
});
process.exit(0);
