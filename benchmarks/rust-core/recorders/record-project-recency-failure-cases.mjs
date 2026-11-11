#!/usr/bin/env node
// Recording of apps/desktop/src/main/project-recency-failure.test.mjs (b6f10295a): the desktop's project registry when only the
// recency write fails (a real rename failure injected on the registry file), a failure of the registry read, and a corrupt registry.
// Real SessionHost (session-host.ts) and DesktopProjectRegistry over the real shared/projects.mjs (a fresh instance per case, its
// MIXDOG_PROJECTS_FILE pointing at the case's temp registry); the daemon client is scripted (create/submit/unsubscribe counters).
// The parametrised Node tests (submission x {publication, corrupt registry}; explicit {add,enter,rename,remove,touch}) are recorded as
// one case each with a list of runs, the case names being the Node test names with the ${…} template. Paths are <root>/…
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
const failure = (e) => ({ name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e) });

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
  const escaped = JSON.stringify(root).slice(1, -1);
  /** Every string in alue with the temp root (raw or JSON-escaped, as inside a registry file's text) written <root>. */
  const rel = (value) => JSON.parse(JSON.stringify(value ?? null, (_, v) => (typeof v === 'string' ? v.replaceAll(escaped, '<root>').replaceAll(root, '<root>') : v)));
  return { root, project, file, original, store, registry, host, calls, client, patch, failRegistryPublication, cleanup, rel };
}
const withFixture = async (fn) => { const f = await fixture(); try { return await fn(f); } finally { await f.cleanup(); } };

await set.run('startProjectTask opens and publishes its shell despite a real recency publication failure', () => withFixture(async (f) => {
  const failed = f.failRegistryPublication();
  const snapshot = await f.host.startProjectTask(f.project);
  return f.rel({ snapshotCwd: snapshot.cwd, snapshotCurrentProject: snapshot.currentProject, hostSnapshotCwd: f.host.getSnapshot().cwd, renameAttempts: failed.attempts(), registryFile: fs.readFileSync(f.file, 'utf8'), originalRegistry: f.original });
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
      return f.rel({ cause, options, accepted: result.accepted, snapshotSessionIdIsResultSessionId: result.snapshot.sessionId === result.sessionId, receiptPhase: receipt.phase, receiptSessionIdIsResultSessionId: receipt.sessionId === result.sessionId, retryAccepted: retry.accepted, calls: f.calls });
    }));
  }
  return { runs };
});

await set.run('enter keeps registration and unhiding when only the recency write fails', () => withFixture(async (f) => {
  fs.writeFileSync(join(f.root, 'desktop-projects.json'), JSON.stringify({ version: 2, hidden: [f.project], aliases: {} }));
  const failed = f.failRegistryPublication();
  const entered = await f.registry.enter(f.project);
  return f.rel({ startFiles: { 'desktop-projects.json': { version: 2, hidden: ['<root>/project'], aliases: {} } }, entered, renameAttempts: failed.attempts(), hiddenAfter: JSON.parse(fs.readFileSync(join(f.root, 'desktop-projects.json'), 'utf8')).hidden, knownPath: await f.registry.knownPath(f.project), project: f.project });
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
      try { await run(); outcome = { rejected: false }; } catch (e) { outcome = { rejected: true, isTheOriginalError: e === failed.failure, error: failure(e) }; }
      return f.rel({ action, ...outcome, renameAttempts: failed.attempts(), registryFileUnchanged: fs.readFileSync(f.file, 'utf8') === f.original, hostSnapshot: f.host.getSnapshot() });
    }));
  }
  return { runs };
});

await set.run('registration and project-authority failures are not swallowed as recency failures', () => withFixture(async (f) => {
  const err = Object.assign(new Error('registry unreadable'), { code: 'EIO' });
  const read = fs.readFileSync;
  f.patch('readFileSync', (file, ...args) => { if (file === f.file) throw err; return read(file, ...args); });
  const attempt = async (fn) => { try { await fn(); return { rejected: false }; } catch (e) { return { rejected: true, isTheOriginalError: e === err }; } };
  const results = { startProject: await attempt(() => f.host.startProject(f.project)), startProjectTask: await attempt(() => f.host.startProjectTask(f.project)), submitNewTask: await attempt(() => f.host.submitNewTask('must not start', { id: 'bad-registry' }, { projectPath: f.project })) };
  const calls = { ...f.calls };
  fs.readFileSync = read; syncBuiltinESMExports();
  return f.rel({ injected: failure(err), results, calls, registryFileUnchanged: fs.readFileSync(f.file, 'utf8') === f.original });
}));

await set.run('a corrupt registry is recovered: its bytes are kept aside and project start still works', () => withFixture(async (f) => {
  fs.writeFileSync(f.file, '{broken');
  let first;
  try { await f.host.startProjectTask(f.project); first = { rejected: false }; } catch (e) { first = { rejected: true, name: e?.name ?? null, code: e?.code ?? null, isSyntaxError: e instanceof SyntaxError }; }
  await f.host.addProject(f.project);
  const snapshot = await f.host.startProjectTask(f.project);
  const asides = fs.readdirSync(f.root).filter((name) => name.startsWith('projects.json.corrupt-'));
  return f.rel({ registryBytes: '{broken', firstStart: first, snapshotCwd: snapshot.cwd, projectIsCwd: snapshot.cwd === f.project, asideCount: asides.length, asideName: 'projects.json.corrupt-<stamp>', asideBytes: asides.length ? fs.readFileSync(join(f.root, asides[0]), 'utf8') : null });
}));

await set.finish({
  entry: { runs: 'apps/desktop SessionHost + DesktopProjectRegistry over shared/projects.mjs with a scripted daemon client; fs.renameSync / fs.readFileSync patched to fail on the registry file', notRun: 'no daemon, no Electron' },
  replay: { entry: 'mixdog-store registry.rs (+ app-server host): a failing recency write must not fail enter/start/submit, explicit registry changes still reject the original error, a corrupt registry is kept aside', normalised: { dataDir: '<root>' } },
  replaceInText: roots.map((r) => [r, '<root>']),
});
process.exit(0);
