#!/usr/bin/env node
// Recording of apps/desktop/src/main/shell-job-stop-lifecycle.test.mjs (b6f10295a): through the daemon's own wiring (session service ->
// local session bridge -> SessionHost) a session is reclaimed as idle and unwatched, loaded again on demand, then a background shell job is
// started on the REAL native spawn server, stopped, and the job rows the pane receives are read from the host's session-state publication.
// It records the two facts of that lifecycle: a session holding a running background shell is never reclaimed, and the terminal row
// reaches the pane after reclaim -> reload -> stop.
// The native spawn binary is a build of native/mixdog-spawn that already exists (no build here): --spawn-binary <exe>, named with its sha256
// in the manifest. Nothing sleeps or polls: setTimeout / setInterval run on a virtual clock (the idle delay is advanced, the 200 ms
// auto-background timer is advanced once it is armed) and every wait is on the event that ends the step, with a deadline on the real clock.
// Generated ids are scripted (crypto.randomUUID is a counter).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-shell-job-stop-lifecycle-cases.mjs --tree <export of b6f10295a with node_modules> \
//        --spawn-binary C:\Users\tempe\.mixdog\data\scratch\rust-core\k1\mixdog-spawn-o1-debug.exe
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RecorderError } from './lib/recorder-error.mjs';
import { openSet } from './lib/case-set.mjs';
import { scriptUuids } from './lib/scripted-uuid.mjs';
import { realDeadline, realTimers, virtualTimers } from './lib/virtual-timers.mjs';

const flag = process.argv.indexOf('--spawn-binary');
const binaryAt = flag >= 0 ? process.argv[flag + 1] : 'C:\\Users\\tempe\\.mixdog\\data\\scratch\\rust-core\\k1\\mixdog-spawn-o1-debug.exe';
if (!binaryAt || !existsSync(binaryAt)) throw new RecorderError('--spawn-binary <existing mixdog-spawn executable> is required');
const scriptedUuids = scriptUuids();
// The real wall clock plus the virtual elapsed time: the job records are files stamped by the real clock, and the pane reads their age.
const set = openSet('shell-job-stop-lifecycle-cases', import.meta.url, { clock: false, classes: { ExecResult: (value) => ({ ...value }) } });
const realNow = Date.now;
const T0 = realNow();
const T = 'src/runtime/agent/orchestrator/tools/';
const { fixtureRoot } = await set.load(`${T}lib/isolated-test-env.mjs`);
const { createDesktopRuntime } = await set.load('src/standalone/daemon-desktop-runtime.mjs');
const { createLocalSessionBridge } = await set.load('src/standalone/daemon-local-session-bridge.mjs');
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { registerBackgroundTask } = await set.load('src/runtime/shared/background-tasks.mjs');
const { execShellCommand } = await set.load(`${T}shell-command.mjs`);
const { killShellJob, shutdownShellJobs, watchBackgroundShellJob } = await set.load(`${T}builtin/shell-jobs.mjs`);
const { stopBackgroundShellJob } = await set.load(`${T}builtin/task-tool.mjs`);
const { _resetNativeSpawnClientForTest, _setNativeSpawnBinaryForTest, shutdownNativeSpawnServer } = await set.load(`${T}lib/native-spawn-client.mjs`);
const { SessionHost } = await set.load('apps/desktop/src/main/session-host.ts');
_setNativeSpawnBinaryForTest(binaryAt);

const SESSION = 'sess_lifecycle_owner';
const IDLE_EVICT_MS = 300;
const DEADLINE_MS = 60_000;
const within = (label, promise) => realDeadline(label, promise, DEADLINE_MS);
const sha256 = createHash('sha256').update(readFileSync(binaryAt)).digest('hex');

await set.run('a job started after reclaim and reload reaches the pane as stopped; a running job keeps its session loaded', async () => {
  const virtual = virtualTimers();
  Date.now = () => T0 + virtual.elapsed();
  const steps = [];
  const status = () => structuredClone(service.status);
  const mark = (step, extra = {}) => steps.push({ step, atMs: virtual.elapsed(), status: status(), paneRowCount: paneRows.length, ...extra });
  const hostPid = process.pid;
  const runtimes = []; const disposed = [];
  let service = null; let paneWaiter = null; let runtimeWaiter = null; let disposeWaiter = null;
  const paneRows = [];
  const bridge = createLocalSessionBridge({ getSessionService: () => service, log: () => {} });
  const desktopRuntime = createDesktopRuntime({ getLocalSessionBridge: () => bridge });
  service = createSessionService({
    createSessionRuntime: async ({ sessionId }) => {
      const state = { sessionId, items: [], queued: [], busy: false, clientHostPid: hostPid };
      const runtime = {
        getState: () => state,
        resume: async () => true,
        subscribe: () => () => {},
        stopShellJob: (taskId) => stopBackgroundShellJob(taskId, { callerSessionId: sessionId, clientHostPid: hostPid }),
        dispose: async () => { disposed.push(sessionId); disposeWaiter?.resolve(); disposeWaiter = null; },
      };
      runtimes.push(runtime);
      runtimeWaiter?.resolve(); runtimeWaiter = null;
      return runtime;
    },
    desktopRuntime,
    onFrame: (frame, targets) => bridge.publish(frame, targets),
    publishIntervalMs: 0,
    idleEvictMs: IDLE_EVICT_MS,
    log: () => {},
  });
  const host = await SessionHost.create(
    { userDataPath: fixtureRoot, resourcesPath: fixtureRoot, appPath: fixtureRoot, packaged: false },
    { ...desktopRuntime, loadProjects: async () => ({}), loadSessionStore: async () => ({}) },
  );
  /** The pane receives a job row: resolves with the first published shellJobs for which `test` holds. */
  const paneUntil = (label, test) => {
    const found = paneRows.find(test);
    if (found) return Promise.resolve(found);
    return within(label, new Promise((resolve) => { paneWaiter = { test, resolve }; }));
  };
  /** shellJobsStatusFresh decides from the files under <MIXDOG_DATA_DIR>/shell-jobs: `<id>.json` (written by the spawn server, carrying the pid, which is
   *  already alive when the record exists), `<id>.done` (the end marker, no liveness check), `.owner-<pid>` and `<id>.enforced`. Every one is a file in
   *  that directory, so the event is a directory change: a watch on the data directory (recursive, armed before the first look so the directory's own
   *  creation is seen). The look is a directory LISTING (names only), once on entry and once per change event, never on a timer: reading `<id>.json`
   *  itself here would hold the file the writer is about to rename over (Windows refuses, the writer backs off on a virtual timer that nobody advances
   *  and the record never lands). The whole wait keeps its RecorderError deadline. */
  const jobDirShows = (label, test) => within(label, new Promise((resolve, reject) => {
    const dir = join(process.env.MIXDOG_DATA_DIR, 'shell-jobs');
    const watcher = watch(process.env.MIXDOG_DATA_DIR, { recursive: true });
    let finished = false;
    const done = (fn, value) => { if (finished) return; finished = true; watcher.close(); fn(value); };
    const look = async () => {
      let names;
      try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return; done(reject, e); return; }
      if (!finished && test(names)) done(resolve, names);
    };
    watcher.on('change', look);
    watcher.on('error', (e) => done(reject, new RecorderError(`${label}: the data directory watch failed: ${e.message}`)));
    look();
  }));  /** The pane row arrives through the host's own 5 s timer: one explicit 5000 ms advance (recorded by the clock in timers.advances), then the
   *  publication it causes is awaited. */
  const WATCH_MS = 5_000;
  const paneAfterAdvance = (label, test) => {
    const arrived = new Promise((resolve) => { paneWaiter = { test, resolve }; });
    virtual.advance(WATCH_MS);
    return within(`${label}: the pane row to be published`, arrived).finally(() => { paneWaiter = null; });
  };  host.subscribeSessionStates((update) => {
    if (update.sessionId === SESSION && update.snapshot?.shellJobs) {
      paneRows.push(structuredClone(update.snapshot.shellJobs));
      if (paneWaiter && paneWaiter.test(paneRows.at(-1))) { const { resolve } = paneWaiter; paneWaiter = null; resolve(paneRows.at(-1)); }
    }
  });
  try {
    // Reclaim: the pane leaves, the session is idle and unwatched, the daemon evicts it.
    await service.createSession({ sessionId: SESSION });
    await host.setVisibleSessions([SESSION]);
    mark('created and shown');
    await host.setVisibleSessions([]);
    disposeWaiter = Promise.withResolvers();
    const reclaimed = disposeWaiter.promise;
    virtual.advance(IDLE_EVICT_MS * 4);
    await within('the idle session to be reclaimed', reclaimed);
    await within('the eviction to finish', virtual.idle());
    mark('hidden; the idle delay advanced; reclaimed', { disposedSessions: [...disposed] });
    // Reload on demand: the pane returns.
    await host.setVisibleSessions([SESSION]);
    mark('shown again (reloaded)', { runtimesCreated: runtimes.length });

    const started = execShellCommand({
      shell: process.execPath, shellArg: '', env: process.env, cwd: fixtureRoot, command: 'serve', directArgv: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 0, autoBackgroundMs: 200, backgroundOnTimeout: true, ownerSessionId: SESSION, callerSessionId: SESSION, clientHostPid: hostPid,
    });
    await within('the auto-background timer to be armed', virtual.whenArmed((t) => t.api === 'setTimeout' && t.ms === 200));
    virtual.advance(200);
    const result = await within('the command to move to the background', started);
    const jobId = result.jobId;
    const context = { callerSessionId: SESSION, routingSessionId: SESSION, clientHostPid: hostPid };
    registerBackgroundTask({ taskId: jobId, surface: 'shell', operation: 'shell', label: 'serve', context, cancel: () => killShellJob(jobId) });
    watchBackgroundShellJob(jobId, context);
    await jobDirShows('the job record to be on disk as running', (names) => names.includes(`${jobId}.json`) && !names.includes(`${jobId}.done`));
    const running = await paneAfterAdvance('the running job to reach the pane', (rows) => rows.jobs.some((row) => row.taskId === jobId));
    mark('the job runs and is on the pane', { started: result, running });

    // The pane leaves again: with the job running the session stays loaded well past the idle delay.
    await host.setVisibleSessions([]);
    virtual.advance(4 * IDLE_EVICT_MS);
    await within('the idle sweeps to finish', virtual.idle());
    mark('hidden with the job running; the idle delay advanced 4x', { disposedSessions: [...disposed] });

    const stopFrom = virtual.armed.length;
    const stopped = await within('the stop to answer', host.stopShellJob(SESSION, jobId));
    await jobDirShows('the job record to be on disk as ended', (names) => names.includes(`${jobId}.done`) && !names.some((name) => name.includes('.mixdog-tmp-')));
    // the stop's completion chain in Node's code arms a 30 minute timer when it has run its course: that arming is the event the clock waits for, so the later advance never lands in the middle of it
    await within('the stop completion to arm its 30 minute timer', virtual.whenArmedAfter(stopFrom, (t) => t.api === 'setTimeout' && t.ms === 1_800_000));
    const settled = await paneAfterAdvance('the terminal row to reach the pane after the stop', (rows) => rows.finished.some((row) => row.taskId === jobId));
    mark('stopped', { stopped, settled, lastPane: paneRows.at(-1) });
    return { sessionId: SESSION, idleEvictMs: IDLE_EVICT_MS, jobId, steps, paneRows, timers: { armed: virtual.armed, fired: virtual.fired, advances: virtual.advances, pending: virtual.pending() } };
  } finally {
    virtual.restore();
    Date.now = realNow;
    await host.dispose().catch(() => {});
    await service.stop('test');
    await shutdownShellJobs('test-cleanup');
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
  }
});

await set.finish({
  entry: {
    runs: 'standalone/session-service.mjs createSessionService (idle eviction), daemon-local-session-bridge.mjs, daemon-desktop-runtime.mjs, the desktop SessionHost (setVisibleSessions, subscribeSessionStates, stopShellJob), tools/shell-command.mjs execShellCommand (auto background), builtin/shell-jobs.mjs, builtin/task-tool.mjs stopBackgroundShellJob, native-spawn-client.mjs over the REAL native spawn server',
    notRun: 'no Electron; the session runtime is the test\'s scripted object (state, stopShellJob, dispose); timers are virtual',
    nativeSpawnBinary: { path: binaryAt, sha256, bytes: readFileSync(binaryAt).length, sourceCommit: '6bf0a5bbf (o1)', sourceTree: 'native/mixdog-spawn tree 6d9cf9666bdf622151ae5d9ff78c4bbdbe560baa at 6bf0a5bbf; the same tree id is at HEAD of the branch (w11) that built the binary', note: 'a debug build made by another worker; its sources are the committed tree above (its working-copy Cargo.lock differed, so the build is not bit-reproducible from o1). Nothing in golden.json depends on it: no path, version or build string is recorded, only job rows, statuses and exit codes. A replay must build native/mixdog-spawn from o1 6bf0a5bbf itself (cargo build, not run here) and must not compare the sha256 of this binary, which is provenance only.' },
    scripted: scriptedUuids,
  },
  replay: { entry: 'mixdog-spawn native server + mixdog-tools shell jobs (stop of a background job) + mixdog-core-session idle eviction: replay the steps (reclaim, reload, start, hide, stop) against the Rust job and session stack with the recorded timers; compare the pane rows whole', normalised: {} },
  replaceInText: [[fixtureRoot, '<fixtureRoot>']],
  replaceRegex: [[/job_\d{13}_/g, 'job_<ms>_'], [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>']],
  normaliseReason: 'the isolated test environment root is written <fixtureRoot>; the wall clock is real (the job records are files with real mtimes) plus the virtual elapsed time: job ids job_<ms of the wall clock>_N are written job_<ms>_N and ISO times <iso>, the virtual offsets are in steps[].atMs',
});
process.exit(0);