// Launching the machine daemon when discovery finds none: the detached fork
// with the daemon heap policy, fd 2 on a capture FILE (a V8 fatal abort is
// written below every JS hook and a pipe stops being drained once this worker
// detaches), and a bounded wait for its `ready` IPC message. The fork itself
// is shared with the session client (../daemon-candidate.mjs).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubLoaderVars } from '../../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { withHeapCap } from '../../runtime/shared/heap-cap.mjs';
import { detachedSpawnOpts } from '../../runtime/shared/spawn-flags.mjs';
import { forkDaemonCandidate } from '../daemon-candidate.mjs';

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
  return forkDaemonCandidate({
    launcher: 'channel-worker',
    entry: daemonEntry(),
    cwd,
    env,
    // Same singleton daemon as the session spawn path, so the same heap policy.
    execArgv: withHeapCap('daemon', ['--require', WORKER_PRELOAD]),
    spawnOptions: detachedSpawnOpts,
    detached: Boolean(detachedSpawnOpts.detached),
    dataDir,
    log,
    timeoutMs: READY_TIMEOUT_MS,
  });
}
