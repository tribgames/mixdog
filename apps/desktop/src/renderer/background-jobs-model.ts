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
};

/** Where a Stop request stands; absent before the user pressed Stop. */
export type ShellStopState = 'stopping' | 'failed' | undefined;
export type ShellRowAction = 'stop' | 'stopping' | 'retry' | 'dismiss';

/** The one button a shell row offers: a finished row can only be dismissed;
 *  a running one is stopped, shows it is stopping, or offers a retry. */
export function shellRowAction(row: Pick<JobRow, 'finished'>, stop: ShellStopState): ShellRowAction {
  if (row.finished) return 'dismiss';
  if (stop === 'stopping') return 'stopping';
  return stop === 'failed' ? 'retry' : 'stop';
}

/** A finished shell's status in words: cancelled reads as stopped. */
export function shellFinishedLabel(row: Pick<JobRow, 'status' | 'exitCode'>): string {
  if (row.status === 'cancelled') return t('Island: Stopped');
  if (row.exitCode != null) return t('Island: Exited {{code}}', { code: row.exitCode });
  return t('Island: Finished');
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
