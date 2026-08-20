export interface ShellJobStatusRowLike {
  taskId?: unknown;
  task_id?: unknown;
  command?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
}

export interface ShellJobsStatusLike {
  count?: unknown;
  elapsedLabel?: unknown;
  jobs?: readonly ShellJobStatusRowLike[];
}

function shellJobRowKey(row: ShellJobStatusRowLike): string {
  return [
    String(row.taskId || row.task_id || ''),
    String(row.command || ''),
    String(row.cwd || ''),
    String(row.startedAt ?? ''),
  ].join('\u001f');
}

export function shellJobsStatusEqual(
  previous: ShellJobsStatusLike | null | undefined,
  next: ShellJobsStatusLike | null | undefined,
): boolean {
  if (previous === next) return true;
  if (Number(previous?.count || 0) !== Number(next?.count || 0)
    || String(previous?.elapsedLabel || '') !== String(next?.elapsedLabel || '')) {
    return false;
  }
  const previousJobs = previous?.jobs || [];
  const nextJobs = next?.jobs || [];
  if (previousJobs.length !== nextJobs.length) return false;
  return previousJobs.every((job, index) => shellJobRowKey(job) === shellJobRowKey(nextJobs[index]));
}
