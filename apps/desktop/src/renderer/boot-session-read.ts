import { markBootStage } from './boot-metrics';
import { paneActiveSessionIds, paneLeaves } from './pane-layout';
import { safeLocalStorage } from './local-storage';
import { paneLayoutFileStorage, readStoredPaneLayout } from './pane-workspace-storage';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { requestSessionRead } from './session-read-request';

/** The sessions the stored pane layout will paint (focused pane first), read
 *  exactly as `usePaneWorkspace` restores them. Whether they still exist is
 *  that hook's catalog authorization; here a stale id only fails its read. */
function restoredSessionIds(): string[] {
  const stored = readStoredPaneLayout(safeLocalStorage()) ?? readStoredPaneLayout(paneLayoutFileStorage());
  return stored ? paneActiveSessionIds(paneLeaves(stored.layout), stored.focusedLeafId) : [];
}

/** Starts the transcript read of every restored session before React mounts. The reads are
 *  speculative: a pane that joined a failed one would show "Session unavailable" for a read it
 *  never asked for. A remote renderer is skipped: its connect-time view sync already delivers them. */
export function startRestoredSessionReads(): void {
  if (isRemoteHostRenderer()) return;
  const sessionIds = restoredSessionIds();
  if (sessionIds.length === 0) return;
  markBootStage('restored-session-read');
  for (const sessionId of sessionIds) void requestSessionRead(sessionId, { speculative: true });
}
