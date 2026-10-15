import { useSessionChanges } from './session-changes-store';

/** The pane's rows: the same Changes store the composer chip reads (so the
 *  list, title and totals match it), plus the pane's own read states. */
export function useSessionDiffRows(sessionId: string, active: boolean, cwd: string | undefined) {
  const changes = useSessionChanges({ cwd, sessionId, active });
  return {
    ...changes,
    /** The non-Git runtime declined to produce a session diff. */
    unsupported: changes.diff?.supported === false,
    // A whole-diff failure: one notice, every row keeps its counts.
    truncated: changes.diff?.patchTruncated === true && !changes.diffTooLarge,
  };
}
