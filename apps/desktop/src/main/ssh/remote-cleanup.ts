// Removes what the desktop installed on a server: stops the Mixdog core there
// (`mixdogd server-ensure` with mode `cleanup`: only a core proven to run
// from ~/.mixdog-remote/versions is stopped, through the control listener's
// wind-down, never a signal; a core of the user's own install has another
// runtime root and is never touched) and deletes ~/.mixdog-remote, keeping
// `user-data` unless asked otherwise. The removal stops, proves nothing else
// runs from the install, and deletes inside one hold of the server-wide
// install lock. The server's runtime does all of it, so cleaning a server that
// holds none of this desktop's build uploads it first.
import { resolveServerPayloads, type ServerPayloads } from './remote-install-payload';
import {
  REMOTE_PROBE_TIMEOUT_MS,
  runRemoteProgram,
  runWithInstall,
} from './remote-bootstrap';
import { REMOTE_INSTALL_LOCK_STALE_MS, REMOTE_INSTALL_LOCK_WAIT_MS, type RemoteProgramArgs } from './remote-install-program';
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
  /** Test seams: the ssh child factory and the runtimes to upload when needed. */
  spawnImpl?: SshSpawn;
  payloads?: ServerPayloads;
}

/** One cleanup step's server result. */
interface CleanupResult {
  stopped: { pid: number; stopped: boolean; reason?: string } | null;
  removed: string[];
  kept: string[];
}

const REMOTE_CLEANUP_TIMEOUT_MS = 330_000;

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
  if (!stopped) return 'no core running';
  if (stopped.stopped) return `stopped pid ${stopped.pid}`;
  return `left pid ${stopped.pid} running (not proven to be the desktop's core)`;
}

export async function cleanupRemoteServer(target: string, options: RemoteCleanupOptions): Promise<void> {
  const sshTarget = parseSshTarget(target);
  const run = { target: sshTarget, spawnImpl: options.spawnImpl };
  options.onProgress?.({ phase: 'connect' });
  const payloads = options.payloads ?? (await resolveServerPayloads());
  const { installId, version, build } = payloads.identity;
  const base: RemoteProgramArgs = {
    mode: 'probe',
    installId,
    version,
    build,
    lockWaitMs: REMOTE_INSTALL_LOCK_WAIT_MS,
    lockStaleMs: REMOTE_INSTALL_LOCK_STALE_MS,
  };
  const probe = await runRemoteProgram(run, base, REMOTE_PROBE_TIMEOUT_MS);
  // The first run installs this build when it was missing; the second finds it.
  let installed = probe.result.installed === true;
  const step = async (phase: 'stop' | 'remove'): Promise<CleanupResult> => {
    const args: RemoteProgramArgs = { ...base, mode: 'cleanup', phase, removeUserData: options.removeUserData === true };
    const result = await runWithInstall(run, payloads, probe.platform, args, installed, REMOTE_CLEANUP_TIMEOUT_MS);
    installed = true;
    return cleanupResultOf(result.cleanup);
  };
  // The server refuses with daemon-unproven when the core record names a
  // process it cannot prove, and the remove run re-checks under its own lock
  // hold that nothing still runs from the install before deleting.
  const stop = await step('stop');
  options.onProgress?.({ phase: 'stop', detail: describeStop(stop.stopped) });
  const removal = await step('remove');
  options.onProgress?.({
    phase: 'remove',
    detail: `removed ${removal.removed.length ? removal.removed.join(', ') : 'nothing'}${removal.kept.length ? `; kept ${removal.kept.join(', ')}` : ''}`,
  });
  options.onProgress?.({ phase: 'done' });
}
