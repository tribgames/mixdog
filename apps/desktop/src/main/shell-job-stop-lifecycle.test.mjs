// Through the daemon's own wiring (session service -> local bridge ->
// SessionHost): a session reclaimed as idle and unwatched, loaded again on
// demand, then a background shell job started, stopped, and the job rows the
// pane would receive read from the host's session-state publication.
//
// It pins two facts of that lifecycle: a session holding a running background
// shell is never reclaimed (so a reclaim cannot sit between a job's start and
// its stop), and the terminal row reaches the pane after reclaim -> reload ->
// stop.
import { fixtureRoot } from '../../../../src/runtime/agent/orchestrator/tools/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { waitUntil } from '../../../../src/runtime/shared/wait-until.test-support.mjs';
import { createDesktopRuntime } from '../../../../src/standalone/daemon-desktop-runtime.mjs';
import { createLocalSessionBridge } from '../../../../src/standalone/daemon-local-session-bridge.mjs';
import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { registerBackgroundTask } from '../../../../src/runtime/shared/background-tasks.mjs';
import { execShellCommand } from '../../../../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import {
  killShellJob,
  shutdownShellJobs,
  watchBackgroundShellJob,
} from '../../../../src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs';
import { stopBackgroundShellJob } from '../../../../src/runtime/agent/orchestrator/tools/builtin/task-tool.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  shutdownNativeSpawnServer,
} from '../../../../src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs';
import { SessionHost } from './session-host.ts';

const binary = resolve(
  '../../native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
);
const skip = existsSync(binary) ? false : `native spawn test binary not found: ${binary}`;
if (!skip) _setNativeSpawnBinaryForTest(binary);

const SESSION = 'sess_lifecycle_owner';
const IDLE_EVICT_MS = 300;

test('a job started after reclaim and reload reaches the pane as stopped; a running job keeps its session loaded', {
  skip,
  timeout: 90_000,
}, async (t) => {
  const hostPid = process.pid;
  const runtimes = [];
  let service = null;
  const bridge = createLocalSessionBridge({ getSessionService: () => service, log: () => {} });
  const desktopRuntime = createDesktopRuntime({ getLocalSessionBridge: () => bridge });
  service = createSessionService({
    createSessionRuntime: async ({ sessionId }) => {
      const state = { sessionId, items: [], queued: [], busy: false, clientHostPid: hostPid };
      const runtime = {
        getState: () => state,
        resume: async () => true,
        subscribe: () => () => {},
        stopShellJob: (taskId) =>
          stopBackgroundShellJob(taskId, { callerSessionId: sessionId, clientHostPid: hostPid }),
        dispose: async () => {},
      };
      runtimes.push(runtime);
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
    { ...desktopRuntime, loadProjects: async () => ({}), loadSessionStore: async () => ({}) }
  );
  const paneRows = [];
  host.subscribeSessionStates((update) => {
    if (update.sessionId === SESSION && update.snapshot?.shellJobs) paneRows.push(update.snapshot.shellJobs);
  });
  t.after(async () => {
    await host.dispose().catch(() => {});
    await service.stop('test');
    await shutdownShellJobs('test-cleanup');
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
  });

  // Reclaim: the pane leaves, the session is idle and unwatched, the daemon evicts it.
  await service.createSession({ sessionId: SESSION });
  await host.setVisibleSessions([SESSION]);
  await host.setVisibleSessions([]);
  await waitUntil(() => service.status.live === 0, { timeoutMs: 10_000, message: 'the idle session was never reclaimed' });
  // Reload on demand: the pane returns.
  await host.setVisibleSessions([SESSION]);
  assert.equal(service.status.live, 1);

  const started = await execShellCommand({
    shell: process.execPath,
    shellArg: '',
    env: process.env,
    cwd: fixtureRoot,
    command: 'serve',
    directArgv: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 0,
    autoBackgroundMs: 200,
    backgroundOnTimeout: true,
    ownerSessionId: SESSION,
    callerSessionId: SESSION,
    clientHostPid: hostPid,
  });
  const jobId = started.jobId;
  const context = { callerSessionId: SESSION, routingSessionId: SESSION, clientHostPid: hostPid };
  registerBackgroundTask({ taskId: jobId, surface: 'shell', operation: 'shell', label: 'serve', context, cancel: () => killShellJob(jobId) });
  watchBackgroundShellJob(jobId, context);
  await waitUntil(() => paneRows.at(-1)?.jobs.some((row) => row.taskId === jobId), {
    timeoutMs: 15_000,
    message: 'the running job never reached the pane',
  });

  // The pane leaves again: with the job running the session stays loaded well past the idle delay.
  await host.setVisibleSessions([]);
  await delay(4 * IDLE_EVICT_MS);
  assert.equal(service.status.live, 1, 'a session holding a running background shell was reclaimed');

  assert.deepEqual(await host.stopShellJob(SESSION, jobId), { stopped: true });
  const settled = await waitUntil(
    () => paneRows.at(-1)?.finished.find((row) => row.taskId === jobId),
    { timeoutMs: 15_000, message: 'no terminal row reached the pane after the stop' }
  );
  assert.equal(settled.status, 'cancelled');
  assert.equal(paneRows.at(-1).jobs.length, 0, 'the stopped job is no longer listed as running');
});
