#!/usr/bin/env node
// Golden twin of `src/session-runtime/lifecycle/session-switch.test.mjs`: `createSessionSwitching`
// (`lifecycle/session-switch.mjs`: deleteSession, listSessions, switchContext, newSession, prefetchSession,
// sessionStoreDir). The manager, the route/cwd setters, the status routes, the agent tool, the memory ingest and the
// session-search forget (`mock.module`) are scripted endpoints that append to one ordered call list; the deleted
// session's rows are real `<id>.json` files in a scratch store dir. The cleanup hand-off is awaited as the event it is: the
// scripted `cleanupDeletedSessionWorktree` endpoint being called (10 s deadline), not a count of event-loop turns.
//
//   node benchmarks/rust-core/recorders/record-session-switch.mjs --tree <dir>
// (re-executes itself with --experimental-test-module-mocks, which `mock.module` needs)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  // The re-executed recorder has a deadline: a hang is killed and reported, never waited for.
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, timeout: 300_000, killSignal: 'SIGKILL' });
  if (child.error) throw new Error(`the re-executed recorder did not finish within 300 s: ${child.error.message}`);
  process.exit(child.status ?? 1);
}

const { mock } = await import('node:test');
const { cleanup, runSessionRecorder } = await import('./lib/session-rec.mjs');
const { exact } = await import('./lib/exact.mjs');
const { Signal } = await import('./lib/session-wire-harness.mjs');
const { resolveTree } = await import('./lib/common.mjs');
const { parseArgs } = await import('./lib/common.mjs');

const dataRoot = mkdtempSync(join(tmpdir(), 'session-switch-'));
process.env.MIXDOG_DATA_DIR = dataRoot;
process.env.MIXDOG_HOME = join(dataRoot, 'home');
mkdirSync(join(dataRoot, 'home'), { recursive: true });

const treeDir = resolveTree(parseArgs());
const forgotten = [];
mock.module(pathToFileURL(join(treeDir, 'src/runtime/session-search/session-search-ingest.mjs')).href, {
  namedExports: { forgetSessionSearch: async (id) => { forgotten.push(id); } },
});

await runSessionRecorder(import.meta.url, {
  set: 'session-switch',
  testFile: 'src/session-runtime/lifecycle/session-switch.test.mjs',
  entry: 'Ran lifecycle/session-switch.mjs (createSessionSwitching) with scripted manager, route/cwd setters, status routes, agent tool, memory ingest and surface closer, and a scripted forgetSessionSearch (mock.module); deleted rows are real <id>.json files in a scratch MIXDOG_DATA_DIR sessions dir. Did not run the real manager, store or worktree cleanup (cleanupDeletedSessionWorktree is a scripted endpoint recording its arguments).',
  replay: 'App-server protocol methods of the Rust core (native/core/crates/mixdog-app-protocol methods.rs): deleteSession -> thread/delete (methods.rs:284; handled by delete.rs delete_session, which is crate-private and reached through that method, and through the pub SessionDirectory::delete_stored of directory.rs for the sweep), switchContext -> thread/switchContext (methods.rs:566), newSession -> thread/start, listSessions -> thread/list; prefetchSession and sessionStoreDir have no protocol method (Rust-side work). Drive the same op with the same thread state and compare the return value, the ordered call list (close with tombstone flag, cancel tasks, clear route, delete, create, ...), the worktree cleanup arguments (S/worktree_maintenance.rs cleanup_deleted_session behind them) and the forgotten session ids, whole and in order.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: ['a function in a recorded call argument (the close option isSessionLive) cannot be encoded: it is recorded as {function: name, resultAtCall, resultAfterOp}, its own return value at the call and after the op', 'the scratch data dir path is replaced by <DATA> in the one value that holds it: the result of sessionStoreDir() (case 255); the separator is the one Node produced', 'the store dir is emptied and rewritten with the case\'s rows before every case (as in the test); its listing is recorded in the OS order, unsorted'],
}, async ({ imp }) => {
  const { createSessionSwitching } = await imp('src/session-runtime/lifecycle/session-switch.mjs');
  const { getStoreDir } = await imp('src/runtime/agent/orchestrator/session/store/session-paths.mjs');
  const signal = new Signal();

  const leadRow = (id, messages = [{ role: 'user', content: 'hi' }]) => ({ id, owner: 'cli', sourceType: 'lead', messages });
  // Functions cannot be encoded: each is recorded with its own return value at the call and, in view(), after the op.
  const fns = [];
  const fnForm = (value) => {
    if (typeof value === 'function') { const placeholder = { function: value.name || 'anonymous', resultAtCall: value.name === 'isSessionLive' ? value() : undefined }; fns.push([placeholder, value]); return placeholder; }
    if (Array.isArray(value)) return value.map(fnForm);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fnForm(v)]));
    return value;
  };

  function fixture({ current = null, rows = [] } = {}) {
    forgotten.length = 0;
    const storeDir = getStoreDir();
    for (const file of readdirSync(storeDir)) rmSync(join(storeDir, file), { force: true });
    for (const row of rows) writeFileSync(join(storeDir, `${row.id}.json`), JSON.stringify(row));
    const calls = [];
    const cleaned = [];
    const state = { session: current, route: { provider: 'p', model: 'm', effort: 'low' }, desktop: null, cwd: 'C:\\one' };
    const mgr = {
      listSessions: () => rows,
      listOwnedAgentSessionIds: (id) => (id === 'parent' ? ['child-a', 'child-a', 'parent', 'bad id!', ' child-b '] : []),
      deleteSession: (id) => { calls.push(['delete', id]); return true; },
      closeSession: (id, reason, opts) => { calls.push(['close', id, reason, fnForm(opts)]); return true; },
      prefetchSession: (id) => { calls.push(['prefetch', id]); return true; },
    };
    const api = createSessionSwitching({
      getSession: () => state.session,
      setSession: (session) => { state.session = session; },
      getRoute: () => state.route,
      setRoute: (route) => { state.route = route; calls.push(['setRoute', route]); },
      getConfig: () => ({}),
      getMode: () => 'full',
      getCurrentCwd: () => state.cwd,
      getMcpScopeId: () => null,
      getDesktopSession: () => state.desktop,
      setDesktopSession: (desktop) => { state.desktop = desktop; },
      mgr,
      statusRoutes: { clearGatewaySessionRoute: (id) => calls.push(['clearRoute', id]) },
      agentTool: { closeAll: (reason, opts) => calls.push(['closeAll', reason, fnForm(opts)]) },
      createCurrentSession: async () => { calls.push(['create']); state.session = { id: 'fresh', messages: [] }; return state.session; },
      refreshRouteEffort: async () => calls.push(['refreshEffort']),
      invalidateContextStatusCache: () => calls.push(['invalidateContext']),
      invalidatePreSessionToolSurface: () => calls.push(['invalidateTools']),
      applyResolvedCwd: async (cwd) => { calls.push(['cwd', cwd]); state.cwd = cwd; },
      resolveRoute: (_config, next) => ({ provider: 'lead-p', model: 'lead-m', ...next }),
      applyDeferredToolSurface: () => {},
      getStandaloneTools: () => [],
      clearRoutePreparation: () => calls.push(['clearPrep']),
      cleanupDeletedSessionWorktree: async (id) => { cleaned.push([id, state.session?.id ?? null, state.cwd]); signal.notify(); },
    }, {
      ingestSessionIntoMemory: async (session) => calls.push(['ingest', session.id]),
      closeSurfaceSession: (session, reason, opts) => calls.push(['closeSurface', session.id, reason, fnForm(opts)]),
      cancelBackgroundTasks: (opts) => calls.push(['cancelTasks', fnForm(opts)]),
    });
    return { api, calls, state, cleaned, rows };
  }

  // The call list is encoded when read (the arguments are the objects the endpoints received); the functions among them report their value after the op.
  const view = (f, extra = {}) => {
    for (const [placeholder, fn] of fns) placeholder.resultAfterOp = fn.name === 'isSessionLive' ? fn() : undefined;
    return exact({ calls: f.calls, cleaned: f.cleaned, forgotten: forgotten.slice(), state: { session: f.state.session, route: f.state.route, desktop: f.state.desktop, cwd: f.state.cwd }, ...extra });
  };
  const cases = [];
  const add = (name, line, input, result) => cases.push({ name, testLine: line, input: exact(input), result });

  // test line 116
  {
    const runs = [];
    const other = fixture({ current: { id: 'other' }, rows: [leadRow('parent')] });
    const deleted = await other.api.deleteSession('parent');
    await signal.until(() => other.cleaned.length === 1, 'the worktree cleanup of the deleted session was handed off (other session is current)');
    runs.push({ label: 'other session is current', deleted: exact(deleted), view: view(other) });
    const bound = {
      id: 'parent', messages: [{ role: 'user', content: 'hi' }],
      workspace: { projectPath: 'C:\\project', repoCommonDir: 'C:\\project\\.git', cwd: 'C:\\worktrees\\fix', worktreeId: 'fix', branch: 'mixdog/fix', baseCommit: null, mergeTarget: 'main', revision: 2, transition: { state: 'idle', txId: null } },
    };
    const current = fixture({ current: bound, rows: [leadRow('parent')] });
    current.state.cwd = 'C:\\worktrees\\fix';
    const deletedBound = await current.api.deleteSession('parent');
    await signal.until(() => current.cleaned.length === 1, 'the worktree cleanup of the deleted session was handed off (bound current session)');
    runs.push({ label: 'a bound current session is deleted', deleted: exact(deletedBound), view: view(current) });
    add('deleted-session-hands-its-worktree-to-the-autocleanup-policy', 116,
      { runs: [{ current: { id: 'other' }, rows: [leadRow('parent')], cwd: 'C:\\one', delete: 'parent' }, { current: bound, rows: [leadRow('parent')], cwd: 'C:\\worktrees\\fix', delete: 'parent' }], steps: 'deleteSession, then one setImmediate turn, then read the cleanup arguments' },
      runs);
  }

  // test line 152
  {
    const f = fixture({ rows: [leadRow('parent')] });
    const results = [await f.api.deleteSession('bad id!'), await f.api.deleteSession('unknown')];
    add('delete-refuses-malformed-or-unlisted-ids-without-touching-the-store', 152, { rows: [leadRow('parent')], deletes: ['bad id!', 'unknown'] }, { results: exact(results), ...view(f), storeFiles: readdirSync(getStoreDir()) });
  }

  // test line 159
  {
    const child = { ...leadRow('child'), owner: 'agent', agent: 'worker', sourceType: 'agent', visibility: 'agent-only', parentSessionId: 'parent' };
    const f = fixture({ current: { id: 'other' }, rows: [child] });
    const listed = f.api.listSessions();
    const deleted = await f.api.deleteSession('child');
    add('agent-session-is-listed-and-deleted-directly', 159, { current: { id: 'other' }, rows: [child], ops: ['listSessions', "deleteSession('child')"] }, { listed: exact(listed), deleted: exact(deleted), ...view(f) });
  }

  // test line 182
  {
    const f = fixture({ current: { id: 'other' }, rows: [leadRow('parent')] });
    const deleted = await f.api.deleteSession('parent');
    add('deleting-a-non-current-session-leaves-linked-children-untouched', 182, { current: { id: 'other' }, rows: [leadRow('parent')], delete: 'parent', ownedAgentSessionIds: ['child-a', 'child-a', 'parent', 'bad id!', ' child-b '] }, { deleted: exact(deleted), ...view(f) });
  }

  // test line 198
  {
    const current = { id: 'parent', messages: [{ role: 'user', content: 'hi' }] };
    const f = fixture({ current, rows: [leadRow('parent')] });
    const deleted = await f.api.deleteSession('parent');
    add('deleting-the-current-session-tombstones-only-it-and-recreates', 198, { current, rows: [leadRow('parent')], delete: 'parent' }, { deleted: exact(deleted), ...view(f) });
  }

  // test line 213
  {
    const current = { id: 'scratch', messages: [] };
    const f = fixture({ current });
    const args = { cwd: 'C:\\two', desktopSession: { classification: 'project' } };
    const result = await f.api.switchContext(args);
    add('switch-context-closes-retargets-cwd-and-returns-to-the-lead-route', 213, { current, args }, { result: exact(result), ...view(f) });
  }

  // test line 233
  {
    const current = { id: 'talked', messages: [{ role: 'user', content: 'x' }] };
    const f = fixture({ current });
    const args = { cwd: 'C:\\two', desktopSession: 'not-an-object', forResume: true };
    const result = await f.api.switchContext(args);
    add('switch-context-for-a-resume-keeps-the-route-the-resumed-session-installs', 233, { current, args }, { result: exact(result), ...view(f) });
  }

  // test line 244
  {
    const current = { id: 'talked', messages: [{ role: 'user', content: 'x' }] };
    const f = fixture({ current });
    const result = await f.api.newSession();
    add('new-session-ingests-closes-then-returns-the-fresh-id', 244, { current }, { result: exact(result), ...view(f) });
  }

  // test line 255
  {
    const f = fixture();
    const result = f.api.prefetchSession('warm');
    add('prefetch-session-and-session-store-dir-delegate', 255, { prefetch: 'warm' }, { result: exact(result), ...view(f), sessionStoreDir: ((dir) => (dir.startsWith(dataRoot) ? '<DATA>' + dir.slice(dataRoot.length) : dir))(f.api.sessionStoreDir()) });
  }

  return { cases };
});
cleanup(dataRoot);
