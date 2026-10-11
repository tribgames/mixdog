/**
 * Which inactive-window ledgers may be recovered. A ledger is recoverable only
 * once its worker is known to be gone; an elevated worker whose termination
 * was never confirmed keeps its ledger held, with the identity of the process
 * that proves it (PID plus start time, so a reused PID is not mistaken for it).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  /** UTC start time in .NET ticks, as a decimal string. */
  startTicks: string;
}

/** The start ticks of the live process with this PID; `null` when none exists.
 *  Rejects when the answer could not be obtained. */
export function readProcessStartTicks(pid: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // CIM answers for elevated processes too, and is the source the elevated
    // launcher reports its worker's creation time from.
    const command =
      `try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}' -ErrorAction Stop } catch { exit 4 }; ` +
      'if (-not $p) { exit 0 }; [Console]::Out.Write($p.CreationDate.ToUniversalTime().Ticks)';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('process identity query timed out'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim() || null);
      else reject(new Error(`process identity query failed with code ${code}`));
    });
  });
}

/** True only when the exact process is verifiably gone: no process has the PID,
 *  or the PID now belongs to a process with a different start time. An
 *  unanswerable query counts as still alive. */
export async function processIdentityGone(
  identity: ProcessIdentity,
  read: (pid: number) => Promise<string | null> = readProcessStartTicks
): Promise<boolean> {
  try {
    const ticks = await read(identity.pid);
    return ticks === null || ticks !== identity.startTicks;
  } catch {
    return false;
  }
}

type Entry = { identity?: ProcessIdentity } | null;

/**
 * Ledgers awaiting recovery. `exited` ones belong to workers confirmed gone
 * and any cleanup may recover them. Held ones belong to a worker that may still
 * be alive and become recoverable only through `promoteGone`.
 */
export function createInactiveLedgerRegistry() {
  const entries = new Map<string, Entry>();
  return {
    /** The owning worker is confirmed exited. */
    exited(path: string): void {
      entries.set(path, null);
    },
    /** The owning worker's termination is unconfirmed; `identity` is the process
     *  whose disappearance proves it. Without one it can never be verified. */
    hold(path: string, identity?: ProcessIdentity): void {
      if (!entries.has(path)) entries.set(path, { identity });
    },
    /** Verifies each held worker's process and promotes those that are gone.
     *  Resolves true only when no ledger remains held. */
    async promoteGone(gone: (identity: ProcessIdentity) => Promise<boolean> = processIdentityGone): Promise<boolean> {
      let none = true;
      for (const [path, held] of [...entries]) {
        if (held === null) continue;
        if (held.identity && (await gone(held.identity))) entries.set(path, null);
        else none = false;
      }
      return none;
    },
    forget(path: string): void {
      entries.delete(path);
    },
    /** Exited ledgers that still exist on disk. */
    recoverable(): string[] {
      return [...entries].filter(([path, held]) => held === null && existsSync(path)).map(([path]) => path);
    },
  };
}
