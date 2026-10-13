// Removes what the desktop installed on a server: stops the desktop-managed
// Mixdog daemon (only one proven to run from ~/.mixdog-remote/versions:
// graceful /stop, then SIGTERM, then SIGKILL; a daemon of the user's own
// install has another runtime root and is never touched) and deletes ~/.mixdog-remote, keeping `user-data`
// unless asked otherwise. The removal stops, proves nothing else runs from
// the install, and deletes inside one hold of the server-wide install lock;
// without Node.js on the server nothing is deleted.
import { runRemoteProgram } from './remote-bootstrap';
import { RemoteBootstrapError } from './remote-install-errors';
import { REMOTE_INSTALL_LOCK_STALE_MS, REMOTE_INSTALL_LOCK_WAIT_MS } from './remote-install-lock';
import { REMOTE_MIN_NODE_MAJOR, REMOTE_STATE_DIRECTORY, type RemoteProgramArgs } from './remote-install-program';
import { parseSshTarget } from './ssh-command';
import type { SshSpawn } from './ssh-exec';

export interface RemoteCleanupProgress {
  phase: 'connect' | 'stop' | 'remove' | 'done';
  detail?: string;
}

export interface RemoteCleanupOptions {
  /** Also delete ~/.mixdog-remote/user-data (pairing, settings). */
  removeUserData: boolean;
  onProgress?: (progress: RemoteCleanupProgress) => void;
  /** Test seam: the ssh child factory. */
  spawnImpl?: SshSpawn;
}

/** One cleanup step's server result. */
interface CleanupResult {
  stopped: { pid: number; stopped: boolean; reason?: string; killed?: boolean } | null;
  removed: string[];
  kept: string[];
}

export const REMOTE_CLEANUP_TIMEOUT_MS = 330_000;

/** Without node the server program cannot take the install lock or prove
 *  which daemon it may stop, so cleanup refuses instead of deleting blind. */
function nodeRequiredError(detail: string): RemoteBootstrapError {
  return new RemoteBootstrapError(
    'node-missing',
    `Cleaning up needs Node.js on the server to prove which Mixdog daemon it may stop (${detail}); nothing was removed. ` +
      `Install Node.js ${REMOTE_MIN_NODE_MAJOR} or newer and try again, or remove it by hand: ` +
      `kill the "pid" in ~/${REMOTE_STATE_DIRECTORY}/runtime/daemon.json, then rm -rf ~/${REMOTE_STATE_DIRECTORY} ` +
      '(leave user-data to keep sessions and settings).'
  );
}

/** The `cleanup` object of a server result. */
function cleanupResultOf(raw: unknown): CleanupResult {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<CleanupResult>;
  return {
    stopped: value.stopped ?? null,
    removed: Array.isArray(value.removed) ? value.removed.map(String) : [],
    kept: Array.isArray(value.kept) ? value.kept.map(String) : [],
  };
}

function describeStop(stopped: CleanupResult['stopped']): string {
  if (!stopped) return 'no daemon running';
  if (stopped.stopped) return `stopped pid ${stopped.pid}${stopped.killed ? ' (killed)' : ''}`;
  return `left pid ${stopped.pid} running (not proven to be the desktop's daemon)`;
}

export async function cleanupRemoteServer(target: string, options: RemoteCleanupOptions): Promise<void> {
  const sshTarget = parseSshTarget(target);
  const run = async (phase: 'stop' | 'remove'): Promise<CleanupResult> => {
    const args: RemoteProgramArgs = {
      mode: 'cleanup',
      phase,
      removeUserData: options.removeUserData === true,
      lockWaitMs: REMOTE_INSTALL_LOCK_WAIT_MS,
      lockStaleMs: REMOTE_INSTALL_LOCK_STALE_MS,
    };
    const result = await runRemoteProgram(
      { target: sshTarget, spawnImpl: options.spawnImpl },
      args,
      REMOTE_CLEANUP_TIMEOUT_MS
    );
    return cleanupResultOf(result.cleanup);
  };
  options.onProgress?.({ phase: 'connect' });
  // The server refuses with daemon-unproven when the daemon record names a
  // process it cannot prove, and the remove run re-checks under its own lock
  // hold that nothing still runs from the install before deleting.
  const stop = await run('stop').catch((error: unknown) => {
    if (error instanceof RemoteBootstrapError && (error.code === 'node-missing' || error.code === 'node-too-old')) {
      throw nodeRequiredError(error.message);
    }
    throw error;
  });
  options.onProgress?.({ phase: 'stop', detail: describeStop(stop.stopped) });
  const removal = await run('remove');
  options.onProgress?.({
    phase: 'remove',
    detail: `removed ${removal.removed.length ? removal.removed.join(', ') : 'nothing'}${removal.kept.length ? `; kept ${removal.kept.join(', ')}` : ''}`,
  });
  options.onProgress?.({ phase: 'done' });
}
