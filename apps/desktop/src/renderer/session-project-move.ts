// A move to another project as the core reports it on the session's
// workspace state: one asked for during a turn waits for the turn's end, and
// one that could not be carried out then says why until the next request.

export type PendingProjectMove = { projectPath: string | null; requestedAt: number };
export type FailedProjectMove = { projectPath: string | null; message: string; at: number };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** `projectPath` is the registered project's path; null is the task workspace. */
function targetPath(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** `workspace.pendingProjectMove` and `workspace.projectMoveFailed`, or null
 *  for each when absent or malformed. The workspace outside a git
 *  repository is an object holding only these fields. */
export function sessionProjectMove(workspace: unknown): {
  pending: PendingProjectMove | null;
  failed: FailedProjectMove | null;
} {
  const state = record(workspace);
  const pendingRecord = record(state?.pendingProjectMove);
  const failedRecord = record(state?.projectMoveFailed);
  const pendingPath = targetPath(pendingRecord?.projectPath);
  const failedPath = targetPath(failedRecord?.projectPath);
  const message = typeof failedRecord?.message === 'string' ? failedRecord.message.trim() : '';
  return {
    pending:
      pendingRecord && pendingPath !== undefined
        ? { projectPath: pendingPath, requestedAt: Number(pendingRecord.requestedAt) || 0 }
        : null,
    failed:
      failedRecord && message
        ? { projectPath: failedPath ?? null, message, at: Number(failedRecord.at) || 0 }
        : null,
  };
}
