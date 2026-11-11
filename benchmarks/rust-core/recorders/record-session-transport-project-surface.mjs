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
import { exact, exactArgs } from './lib/exact.mjs';
import { DETERMINISM, FIXED_CWD, installDeterminism, withLoggedDaemon } from './lib/session-wire-harness.mjs';
import { outcomeExact, runSessionRecorder } from './lib/session-rec.mjs';

installDeterminism();

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-project-surface',
  testFile: 'scripts/session-transport/project-surface.test.mjs',
  entry: 'Case 12: ran src/standalone/session-service.mjs createSessionService().handleCall for every project.* route with a scripted project store (desktopRuntime.loadProjects). Case 144: ran the real session transport (HTTP on 127.0.0.1) behind a TCP tap that records every HTTP exchange (status line, headers in order, body), the real src/standalone/session-client.mjs createSession() remote runtime and the same service/stub runtime as the test (scripts/session-transport/_shared.mjs of the tree), logging every call the service received. Did not run the TUI project picker (line 85, see header of the recorder) nor a real project registry (see the store-registry set for projects.json).',
  replay: 'App-server protocol methods of the Rust core (native/core/crates/mixdog-app-protocol methods.rs, served by mixdog-app-server) over a scripted project store: project.list -> project/list, project.inspect -> project/read, project.add -> project/create, project.touch -> project/touch, project.rename -> project/update, project.remove -> project/delete, project.ensureDirectory -> project/ensureDirectory, and the remote runtime\'s setCwd -> thread/setCwd. Feed each case\'s calls (name, args as recorded in exactArgs form) and compare every result/error and the store\'s own call list; for case 144 compare the ordered service calls (name, args, context) a client makes for listProjects, addProject, setCwd. The HTTP exchange log (`wire`) documents the Node transport only (the Rust transport is the app-server WebSocket).',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'line 85 (TUI project picker) not recorded: TUI client code with no Rust counterpart',
    'wire taps record the HTTP exchanges in request order: `Host` header port value -> <port> and the response `Date` header value -> <date>, at those header paths; and this machine\'s roots (the checkout process.cwd() -> <CWD>, the OS temp dir -> <TMP>, the user home -> <HOME>, in every spelling found: as written, forward slashes, JSON-escaped, URL-encoded, each also lower-cased; text after the root, separators included, is kept) in every request/response startLine, header value, body and event-stream frame (lib/tmp-mark.mjs). The Content-Length is the one Node sent: a message that had a root replaced carries `rewrites` {label: {originalLength, count}} (a label for a spelling other than as written reads "<CWD> (JSON-escaped)"), so length(recorded body) + sum(count * (originalLength - label length)) = Content-Length. No other value is normalised',
    ...DETERMINISM,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const cases = [];

  // test line 12
  {
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
    const calls = [
      ['project.list', []],
      ['project.inspect', [{ path: 'existing-directory' }]],
      ['project.add', [{ path: 'C:\\project' }]],
      ['project.touch', [{ path: 'C:\\project' }]],
      ['project.rename', [{ path: 'C:\\project', name: 'Renamed' }]],
      ['project.ensureDirectory', [{ path: 'C:\\new' }]],
      ['project.remove', [{ path: 'C:\\project' }]],
    ];
    try {
      for (const [name, args] of calls) {
        const before = storeCalls.length;
        const out = await outcomeExact(() => service.handleCall(name, ...args));
        // the store's rows are returned by reference: the snapshot of what the call returned was taken above, the rows now are read next
        steps.push({ name, args: exactArgs(args), ...out, storeCalls: exact(storeCalls.slice(before)), rowsAfter: exact(rows) });
      }
    } finally { await service.stop('recorder end'); }
    cases.push({ name: 'project-registry-and-filesystem-operations-have-one-daemon-api', testLine: 12, input: { store: 'scripted (see recorder)', calls: steps.map(({ name, args }) => ({ name, args })) }, result: { steps } });
  }

  // test line 144
  {
    const rows = [{ name: 'Shared', path: 'C:\\shared' }];
    const touched = [];
    const projectStore = {
      listProjects: () => rows,
      addProject: (path) => { const project = { name: 'Added', path }; rows.push(project); return project; },
      touchProjectSelected: (path) => { touched.push(path); return rows.find((row) => row.path === path) || null; },
    };
    const steps = [];
    const result = await withLoggedDaemon(S, async ({ calls, wire }) => {
      const runtime = await S.createSession({ cwd: 'C:\\initial' });
      const step = async (label, fn) => {
        const beforeCalls = calls.length;
        const mark = wire.mark();
        const out = await outcomeExact(() => Promise.resolve().then(fn));
        steps.push({ label, ...out, serviceCalls: calls.slice(beforeCalls), exchanges: await wire.since(mark), rowsAfter: exact(rows), touched: exact(touched) });
      };
      steps.push({ label: 'createSession({cwd: C:\\initial})', state: exact(runtime.getState()), serviceCalls: calls.slice(), exchanges: await wire.exchanges() });
      await step('runtime.listProjects()', () => runtime.listProjects());
      await step("runtime.addProject('C:\\\\added')", () => runtime.addProject('C:\\added'));
      await step("runtime.setCwd('C:\\\\shared')", () => runtime.setCwd('C:\\shared'));
      steps.push({ label: 'runtime.getState()', state: exact(runtime.getState()) });
      await runtime.dispose('recorder');
      return { allCalls: exact(calls.map((c) => c.name)) };
    }, { desktopRuntime: { loadProjects: async () => projectStore } });
    cases.push({ name: 'remote-tui-project-surface-uses-only-daemon-project-and-cwd-routes', testLine: 144, input: { rows: [{ name: 'Shared', path: 'C:\\shared' }], createSession: { cwd: 'C:\\initial' }, steps: ['listProjects', "addProject('C:\\added')", "setCwd('C:\\shared')"], cwdConstant: FIXED_CWD }, result: { steps, touched: exact(touched), rowsAfter: exact(rows), ...result } });
  }

  return { cases, notRecorded: [{ testLine: 85, name: 'the TUI project picker awaits service switches and contains service failures', reason: 'drives createProjectPicker/createPanelSurface of the Node TUI with scripted callbacks: client UI code, no Rust counterpart' }] };
});
process.exit(0);
