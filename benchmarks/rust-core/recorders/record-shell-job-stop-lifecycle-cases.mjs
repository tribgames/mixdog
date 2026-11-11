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
import { existsSync, readFileSync } from 'node:fs';
import { openSet } from './lib/case-set.mjs';
import { scriptUuids } from './lib/scripted-uuid.mjs';
import { realDeadline, realTimers, virtualTimers } from './lib/virtual-timers.mjs';

const flag = process.argv.indexOf('--spawn-binary');
const binaryAt = flag >= 0 ? process.argv[flag + 1] : 'C:\\Users\\tempe\\.mixdog\\data\\scratch\\rust-core\\k1\\mixdog-spawn-o1-debug.exe';
if (!binaryAt || !existsSync(binaryAt)) throw new Error('--spawn-binary <existing mixdog-spawn executable> is required');
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
  /** The pane row arrives through the job watcher's own timers: advance the virtual clock by its 5 s step until the row is published (each step
   *  waits for the publication event, with a short deadline on the real clock, before the next advance). */
  const paneAdvancing = async (label, test, stepMs = 5_000, maxSteps = 8) => {
    for (let attempt = 1; attempt <= maxSteps; attempt += 1) {
      const found = paneRows.find(test);
      if (found) return found;
      const arrived = new Promise((resolve) => { paneWaiter = { test, resolve }; });
      virtual.advance(stepMs);
      const row = await Promise.race([arrived, new Promise((resolve) => realTimers.setTimeout(() => resolve(null), 3_000))]);
      paneWaiter = null;
      if (row) return row;
    }
    throw new Error(`${label}: not published after ${maxSteps} virtual steps of ${stepMs} ms | allPane=${JSON.stringify(paneRows)} | armedTail=${JSON.stringify(virtual.armed.slice(-12))} | rows=${paneRows.length}`);
  };
  host.subscribeSessionStates((update) => {
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
    const running = await paneAdvancing('the running job to reach the pane', (rows) => rows.jobs.some((row) => row.taskId === jobId));
    mark('the job runs and is on the pane', { started: result, running });

    // The pane leaves again: with the job running the session stays loaded well past the idle delay.
    await host.setVisibleSessions([]);
    virtual.advance(4 * IDLE_EVICT_MS);
    await within('the idle sweeps to finish', virtual.idle());
    mark('hidden with the job running; the idle delay advanced 4x', { disposedSessions: [...disposed] });

    const stopped = await within('the stop to answer', host.stopShellJob(SESSION, jobId));
    const settled = await paneAdvancing('the terminal row to reach the pane after the stop', (rows) => rows.finished.some((row) => row.taskId === jobId));
    mark('stopped', { stopped, settled, lastPane: paneRows.at(-1) });
    return { sessionId: SESSION, idleEvictMs: IDLE_EVICT_MS, jobId, steps, paneRows, timers: { armed: virtual.armed, fired: virtual.fired, pending: virtual.pending() } };
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
    nativeSpawnBinary: { path: binaryAt, sha256, bytes: readFileSync(binaryAt).length, note: 'a debug build of native/mixdog-spawn made by another worker from a tree whose native/mixdog-spawn sources equal o1 6bf0a5bbf (the working copy of its Cargo.lock differs); copied unchanged, not built here' },
    scripted: scriptedUuids,
  },
  replay: { entry: 'mixdog-spawn native server + mixdog-tools shell jobs (stop of a background job) + mixdog-core-session idle eviction: replay the steps (reclaim, reload, start, hide, stop) against the Rust job and session stack with the recorded timers; compare the pane rows whole', normalised: {} },
  replaceInText: [[fixtureRoot, '<fixtureRoot>']],
  replaceRegex: [[/job_\d{13}_/g, 'job_<ms>_'], [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>']],
  normaliseReason: 'the isolated test environment root is written <fixtureRoot>; the wall clock is real (the job records are files with real mtimes) plus the virtual elapsed time: job ids job_<ms of the wall clock>_N are written job_<ms>_N and ISO times <iso>, the virtual offsets are in steps[].atMs',
});
process.exit(0);