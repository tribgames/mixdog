import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { timeMs } from './transcript-primitives';

export type JobKind = 'shell' | 'agent';
export type JobRow = {
  key: string;
  kind: 'shell';
  /** The shell command. */
  label: string;
  startedAt: number;
  /** A shell job that already exited and stays listed until dismissed. */
  finished?: boolean;
  /** Finished shell: exit code, null when it ended without one. */
  exitCode?: number | null;
  /** Finished shell: terminal status (completed, failed, cancelled…). */
  status?: string;
  /** Finished shell: epoch ms it ended; 0 when unknown. */
  finishedAt?: number;
  /** Shell job id (what stopping addresses). */
  taskId?: string;
  /** Shell working directory; '' when unknown. */
  cwd?: string;
  /** Killed, but its processes are not confirmed gone: the folder stays held
   *  until they are, or until the user releases it. */
  terminationUnconfirmed?: boolean;
};

/** Where a Stop (or Release) request stands; absent before the user acted.
 *  'unconfirmed': the kill was delivered but the processes are not yet
 *  confirmed gone; they keep being terminated. */
export type ShellStopState = 'stopping' | 'unconfirmed' | 'failed' | undefined;
export type ShellRowAction = 'stop' | 'stopping' | 'retry' | 'dismiss' | 'release';

/** The one button a shell row offers: a finished row can only be dismissed;
 *  a row whose termination is unconfirmed offers "Release anyway"; a running
 *  one is stopped. Either request shows it is in flight, or offers a retry. */
export function shellRowAction(
  row: Pick<JobRow, 'finished' | 'terminationUnconfirmed'>,
  stop: ShellStopState
): ShellRowAction {
  if (row.finished) return 'dismiss';
  if (stop === 'stopping' || stop === 'unconfirmed') return 'stopping';
  if (stop === 'failed') return 'retry';
  return row.terminationUnconfirmed ? 'release' : 'stop';
}

/** A finished shell that exited cleanly: exit code 0, neither failed nor stopped. */
export function shellFinishedOk(row: Pick<JobRow, 'status' | 'exitCode'>): boolean {
  return row.exitCode === 0 && row.status !== 'failed' && row.status !== 'cancelled';
}

/** A finished shell's status in words: stopped, ended (exit 0) or failed. */
export function shellFinishedLabel(row: Pick<JobRow, 'status' | 'exitCode'>): string {
  if (row.status === 'cancelled') return t('Island: Stopped');
  return shellFinishedOk(row) ? t('Island: Exited') : t('Failed');
}

/** How long a cleanly exited shell stays listed after it finished. */
export const SHELL_AUTO_DISMISS_MS = 60_000;

/** The cleanly exited rows whose listing time is over (`seenAt` stands in for
 *  an unknown finish time), and when the next one lapses (0 when none waits).
 *  Failed and stopped rows stay until the user dismisses them. */
export function expiredShellRows(
  rows: readonly JobRow[],
  now: number,
  seenAt: (row: JobRow) => number,
  holdMs: number = SHELL_AUTO_DISMISS_MS
): { keys: string[]; nextAt: number } {
  const keys: string[] = [];
  let nextAt = 0;
  for (const row of rows) {
    if (!row.finished || !shellFinishedOk(row)) continue;
    const due = (row.finishedAt || seenAt(row)) + holdMs;
    if (due <= now) keys.push(row.key);
    else if (!nextAt || due < nextAt) nextAt = due;
  }
  return { keys, nextAt };
}

/** Last path segment of a working directory ('' for none). */
export function cwdFolderName(cwd: string | undefined): string {
  const segments = String(cwd || '')
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/** Running shell jobs newest first, then finished shells (not in `dismissed`,
 *  newest finish first). Agents are listed from the agent pool instead. */
export function backgroundJobRows(snapshot: Snapshot, dismissed: ReadonlySet<string> = new Set()): JobRow[] {
  const finishedShell = (snapshot.shellJobs?.finished ?? [])
    .map((job, index) => ({
      key: `shell:${String(job.taskId || job.task_id || index)}`,
      kind: 'shell' as const,
      label: String(job.command || '').trim(),
      startedAt: timeMs(job.startedAt),
      finished: true,
      exitCode: Number.isInteger(job.exitCode) ? (job.exitCode as number) : null,
      status: String(job.status || ''),
      finishedAt: timeMs(job.finishedAt),
      taskId: String(job.taskId || job.task_id || ''),
      cwd: String(job.cwd || ''),
    }))
    .filter((row) => !dismissed.has(row.key))
    .sort((a, b) => b.finishedAt - a.finishedAt);
  const shell = (snapshot.shellJobs?.jobs ?? [])
    .map((job, index) => ({
      key: `shell:${String(job.taskId || job.task_id || index)}`,
      kind: 'shell' as const,
      label: String(job.command || '').trim(),
      startedAt: timeMs(job.startedAt),
      taskId: String(job.taskId || job.task_id || ''),
      cwd: String(job.cwd || ''),
      ...(job.terminationUnconfirmed === true ? { terminationUnconfirmed: true } : {}),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
  return [...shell, ...finishedShell];
}

/** How long a running shell that left the host's running list may wait for its
 *  finished record before it is dropped. */
export const SHELL_FINISH_GRACE_MS = 2000;

export type ShellRowRetention = {
  /** The running rows of the last frame. */
  running: ReadonlyMap<string, JobRow>;
  /** Running rows that left the running list without a finished record yet. */
  grace: ReadonlyMap<string, { row: JobRow; since: number }>;
};

export const EMPTY_SHELL_ROW_RETENTION: ShellRowRetention = { running: new Map(), grace: new Map() };

/** The host drops a job from its running list a beat before the finished
 *  record arrives. Keep such a job (still as running) until a row with its key
 *  shows up, or `graceMs` pass. `expiresAt` is when the earliest kept row
 *  lapses (0 when none is kept). */
export function retainVanishedShellRows(
  retention: ShellRowRetention,
  rows: JobRow[],
  now: number,
  graceMs: number = SHELL_FINISH_GRACE_MS
): { rows: JobRow[]; retention: ShellRowRetention; expiresAt: number } {
  const present = new Set(rows.map((row) => row.key));
  const grace = new Map<string, { row: JobRow; since: number }>();
  for (const [key, entry] of retention.grace) {
    if (!present.has(key) && now - entry.since < graceMs) grace.set(key, entry);
  }
  for (const [key, row] of retention.running) {
    if (!present.has(key) && !grace.has(key) && !retention.grace.has(key)) grace.set(key, { row, since: now });
  }
  const running = new Map(rows.filter((row) => !row.finished).map((row) => [row.key, row]));
  if (grace.size === 0) return { rows, retention: { running, grace }, expiresAt: 0 };
  const kept = [...grace.values()].map((entry) => entry.row);
  const merged = [
    ...[...rows.filter((row) => !row.finished), ...kept].sort((a, b) => b.startedAt - a.startedAt),
    ...rows.filter((row) => row.finished),
  ];
  const expiresAt = Math.min(...[...grace.values()].map((entry) => entry.since + graceMs));
  return { rows: merged, retention: { running, grace }, expiresAt };
}
