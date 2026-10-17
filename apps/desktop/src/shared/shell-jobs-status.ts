interface ShellJobStatusRowLike {
  taskId?: unknown;
  task_id?: unknown;
  command?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  status?: unknown;
  exitCode?: unknown;
  finishedAt?: unknown;
  terminationUnconfirmed?: unknown;
}

interface ShellJobsStatusLike {
  count?: unknown;
  elapsedLabel?: unknown;
  jobs?: readonly ShellJobStatusRowLike[];
  finished?: readonly ShellJobStatusRowLike[];
}

function shellJobRowKey(row: ShellJobStatusRowLike): string {
  return [
    String(row.taskId || row.task_id || ''),
    String(row.command || ''),
    String(row.cwd || ''),
    String(row.startedAt ?? ''),
    String(row.status ?? ''),
    String(row.exitCode ?? ''),
    String(row.finishedAt ?? ''),
    row.terminationUnconfirmed === true ? 'unconfirmed' : '',
  ].join('\u001f');
}

export function shellJobsStatusEqual(
  previous: ShellJobsStatusLike | null | undefined,
  next: ShellJobsStatusLike | null | undefined
): boolean {
  if (previous === next) return true;
  if (
    Number(previous?.count || 0) !== Number(next?.count || 0) ||
    String(previous?.elapsedLabel || '') !== String(next?.elapsedLabel || '')
  ) {
    return false;
  }
  const previousJobs = previous?.jobs || [];
  const nextJobs = next?.jobs || [];
  if (previousJobs.length !== nextJobs.length) return false;
  if (!previousJobs.every((job, index) => shellJobRowKey(job) === shellJobRowKey(nextJobs[index]))) return false;
  const previousFinished = previous?.finished || [];
  const nextFinished = next?.finished || [];
  if (previousFinished.length !== nextFinished.length) return false;
  return previousFinished.every((job, index) => shellJobRowKey(job) === shellJobRowKey(nextFinished[index]));
}
