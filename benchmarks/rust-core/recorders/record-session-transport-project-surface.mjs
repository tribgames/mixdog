#!/usr/bin/env node
// Golden twin of `scripts/session-transport/project-surface.test.mjs`: the daemon's project routes
// (`project.list/inspect/add/touch/rename/ensureDirectory/remove` through `createSessionService().handleCall`) and the
// remote runtime client's project calls (`createSession()` -> `listProjects`, `addProject`, `setCwd` over the real
// HTTP session transport). The project store is a scripted endpoint recording its own calls.
//
// NOT recorded: the test at line 85 ("the TUI project picker awaits service switches and contains service failures")
// drives `createProjectPicker` / `createPanelSurface` of the Node TUI (src/tui/app) with scripted store callbacks:
// it tests TUI client code (picker items, notices) that no Rust crate has a counterpart for.
//
//   node benchmarks/rust-core/recorders/record-session-transport-project-surface.mjs --tree <dir>
import { NORMALISED, callOutcome, createNormaliser, withLoggedDaemon } from './lib/session-daemon-harness.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-project-surface',
  testFile: 'scripts/session-transport/project-surface.test.mjs',
  entry: 'Case 12: ran src/standalone/session-service.mjs createSessionService().handleCall for every project.* route with a scripted project store (desktopRuntime.loadProjects). Case 144: ran the real session transport (HTTP on 127.0.0.1), the real src/standalone/session-client.mjs createSession() remote runtime and the same service/stub runtime as the test (scripts/session-transport/_shared.mjs of the tree), logging every call the service received. Did not run the TUI project picker (line 85, see header of the recorder) nor a real project registry (see the store-registry set for projects.json).',
  replay: 'mixdog-app-server dispatch of project/list, project/add, project/inspect, project/touch, project/rename, project/remove, project/ensureDirectory and the cwd change (native/core/crates/mixdog-workspace service.rs project routes): feed each case\'s calls (name, args) to a scripted project store and compare every result/error and the store\'s own call list; for case 144 compare the ordered service calls (name, args, context) a client makes for listProjects, addProject, setCwd.',
  exclusions: [
    'line 85 (TUI project picker) not recorded: TUI client code with no Rust counterpart',
    'wire envelope: the client-visible result of a call is recorded (what createSession returns), plus the call the service received; HTTP headers/bytes are not (the Rust transport is the app-server WebSocket)',
    ...NORMALISED,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const cases = [];

  // test line 12
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const rows = [];
    const storeCalls = [];
    const projectStore = {
      listProjects: () => { storeCalls.push(['listProjects']); return rows; },
      resolveProjectPath: (value) => { storeCalls.push(['resolveProjectPath', value]); return `resolved:${value}`; },
      pathExists: (value) => { storeCalls.push(['pathExists', value]); return value.includes('existing'); },
      isDirectory: (value) => { storeCalls.push(['isDirectory', value]); return value.includes('directory'); },
      addProject: (value) => { storeCalls.push(['addProject', value]); const project = { name: 'Added', path: value }; rows.push(project); return project; },
      touchProjectSelected: (value) => { storeCalls.push(['touchProjectSelected', value]); return rows.find((row) => row.path === value) || null; },
      renameProject: (value, name) => {
        storeCalls.push(['renameProject', value, name]);
        const project = rows.find((row) => row.path === value);
        if (!project) return null;
        project.name = name;
        return project;
      },
      removeProject: (value) => {
        storeCalls.push(['removeProject', value]);
        const index = rows.findIndex((row) => row.path === value);
        if (index < 0) return false;
        rows.splice(index, 1);
        return true;
      },
      ensureDir: (value) => { storeCalls.push(['ensureDir', value]); return `created:${value}`; },
    };
    const service = S.createSessionService({ createSessionRuntime: async () => S.createStubSessionRuntime(), desktopRuntime: { loadProjects: async () => projectStore } });
    const steps = [];
    try {
      for (const [name, args] of [
        ['project.list', undefined],
        ['project.inspect', { path: 'existing-directory' }],
        ['project.add', { path: 'C:\\project' }],
        ['project.touch', { path: 'C:\\project' }],
        ['project.rename', { path: 'C:\\project', name: 'Renamed' }],
        ['project.ensureDirectory', { path: 'C:\\new' }],
        ['project.remove', { path: 'C:\\project' }],
      ]) {
        const before = storeCalls.length;
        steps.push({ name, args: args ?? null, ...(await callOutcome(ids.norm, service.handleCall(name, args))), storeCalls: storeCalls.slice(before) });
      }
    } finally { await service.stop('recorder end'); }
    cases.push({ name: 'project-registry-and-filesystem-operations-have-one-daemon-api', testLine: 12, input: { store: 'scripted (see recorder)', calls: steps.map(({ name, args }) => ({ name, args })) }, result: { steps, rowsAfter: rows } });
  }

  // test line 144
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const rows = [{ name: 'Shared', path: 'C:\\shared' }];
    const touched = [];
    const projectStore = {
      listProjects: () => rows,
      addProject: (path) => { const project = { name: 'Added', path }; rows.push(project); return project; },
      touchProjectSelected: (path) => { touched.push(path); return rows.find((row) => row.path === path) || null; },
    };
    const steps = [];
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ calls }) => {
      const runtime = await S.createSession({ cwd: 'C:\\initial' });
      const step = async (label, fn) => { const before = calls.length; steps.push({ label, ...(await callOutcome(ids.norm, Promise.resolve().then(fn))), serviceCalls: calls.slice(before) }); };
      await step('runtime.listProjects()', () => runtime.listProjects());
      await step("runtime.addProject('C:\\\\added')", () => runtime.addProject('C:\\added'));
      await step("runtime.setCwd('C:\\\\shared')", () => runtime.setCwd('C:\\shared'));
      steps.push({ label: 'runtime.getState().cwd', ok: ids.norm(runtime.getState().cwd), type: typeof runtime.getState().cwd });
      await runtime.dispose('recorder');
      return { allCalls: calls.map((c) => c.name) };
    }, { desktopRuntime: { loadProjects: async () => projectStore } });
    cases.push({ name: 'remote-tui-project-surface-uses-only-daemon-project-and-cwd-routes', testLine: 144, input: { rows: [{ name: 'Shared', path: 'C:\\shared' }], createSession: { cwd: 'C:\\initial' }, steps: ['listProjects', "addProject('C:\\added')", "setCwd('C:\\shared')"] }, result: { steps, touched, rowsAfter: rows, ...result } });
  }

  return { cases, notRecorded: [{ testLine: 85, name: 'the TUI project picker awaits service switches and contains service failures', reason: 'drives createProjectPicker/createPanelSurface of the Node TUI with scripted callbacks: client UI code, no Rust counterpart' }] };
});
process.exit(0);
