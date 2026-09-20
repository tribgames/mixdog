// channel-worker/daemon-spawn.mjs
// Launching the machine daemon when discovery finds none: the detached fork
// with the daemon heap policy, fd 2 on a capture FILE (a V8 fatal abort is
// written below every JS hook and a pipe stops being drained once this worker
// detaches), and a bounded wait for its `ready` IPC message.
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubLoaderVars } from '../../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { withHeapCap } from '../../runtime/shared/heap-cap.mjs';
import { detachedSpawnOpts } from '../../runtime/shared/spawn-flags.mjs';
import { beginDaemonSpawnCapture } from '../daemon-crash-capture.mjs';

const WORKER_PRELOAD = fileURLToPath(new URL('../channel-worker-preload.cjs', import.meta.url));
const READY_TIMEOUT_MS = 20_000;

function daemonEntry() {
  return process.env.MIXDOG_DAEMON_ENTRY
    ? resolve(process.env.MIXDOG_DAEMON_ENTRY)
    : fileURLToPath(new URL('../daemon.mjs', import.meta.url));
}

export function daemonEnv({ rootDir, dataDir, runtimeDir, leadPid }) {
  const env = { ...process.env };
  scrubLoaderVars(env);
  return {
    ...env,
    MIXDOG_ROOT: rootDir,
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_RUNTIME_ROOT: runtimeDir,
    MIXDOG_STANDALONE: '1',
    MIXDOG_WORKER_MODE: '1',
    MIXDOG_DAEMON_HOST: '1',
    MIXDOG_CLI_OWNED: '0',
    MIXDOG_SUPERVISOR_PID: String(leadPid),
    MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
  };
}

/** Resolves once the daemon reported ready, exited, failed to spawn, or the
 *  ready timeout elapsed — the caller re-reads discovery either way. */
export function spawnDaemonCandidate({ cwd, env, dataDir, log }) {
  return new Promise((resolveSpawn) => {
    let settled = false;
    const capture = beginDaemonSpawnCapture({ launcher: 'channel-worker', dataDir, log });
    const done = () => {
      if (settled) return;
      settled = true;
      capture.mirror();
      resolveSpawn();
    };
    // Same singleton daemon as the session spawn path, so the same heap policy.
    const execArgv = withHeapCap('daemon', ['--require', WORKER_PRELOAD]);
    let daemon;
    try {
      daemon = fork(daemonEntry(), [], {
        cwd,
        execArgv,
        stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
        env,
        ...detachedSpawnOpts,
      });
    } catch (error) {
      capture.noteSpawnError(error);
      log(`daemon spawn failed: ${error?.message || error}`);
      done();
      return;
    }
    capture.track(daemon, { detached: Boolean(detachedSpawnOpts.detached), execArgv });
    daemon.once('message', (message) => {
      if (message?.type !== 'ready') return;
      capture.noteReady();
      try {
        daemon.disconnect?.();
      } catch {}
      try {
        daemon.unref?.();
      } catch {}
      try {
        daemon.stderr?.unref?.();
      } catch {}
      done();
    });
    daemon.once('exit', done);
    daemon.once('error', (error) => {
      // An async spawn failure may never emit 'exit'; the sidecar still gets it.
      capture.noteSpawnError(error);
      log(`daemon spawn error: ${error?.message || error}`);
      done();
    });
    const timer = setTimeout(done, READY_TIMEOUT_MS);
    timer.unref?.();
  });
}
