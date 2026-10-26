import { markBootStage } from './boot-metrics';
import { paneActiveSessionIds, paneLeaves } from './pane-layout';
import { paneLayoutFileStorage, readStoredPaneLayout, safeLocalStorage } from './pane-workspace-storage';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { requestSessionRead } from './session-read-request';

/** The sessions the stored pane layout will paint (focused pane first), read
 *  exactly as `usePaneWorkspace` restores them. Whether they still exist is
 *  that hook's catalog authorization; here a stale id only fails its read. */
function restoredSessionIds(): string[] {
  const stored = readStoredPaneLayout(safeLocalStorage()) ?? readStoredPaneLayout(paneLayoutFileStorage());
  return stored ? paneActiveSessionIds(paneLeaves(stored.layout), stored.focusedLeafId) : [];
}

/**
 * Start the transcript read of every restored session at renderer boot,
 * before the app bundle is evaluated and React mounts. The pane's own read
 * (use-session-lane-read) used to be the first one, after the bundle, the
 * first commit and the catalog check — so the cover waited on all of that
 * before the host even began parsing the transcript. It goes through
 * `requestSessionRead`, so the pane's read joins this request while it is in
 * flight and reuses the lane once it landed. The read is `speculative`: the
 * host's calls wait for its start but can still fail or time out before it is
 * ready, and a pane that joined such a failure would show "Session
 * unavailable" for a read it never asked for, so it starts its own instead.
 *
 * A remote renderer (the phone) is left out: its restored session set is
 * already named in the shim's first view sync / registration at connect, which
 * delivers the transcript, and `prefetchSession` waits behind that sync — a
 * read here would be a second copy of it, not an earlier one.
 */
export function startRestoredSessionReads(): void {
  if (isRemoteHostRenderer()) return;
  const sessionIds = restoredSessionIds();
  if (sessionIds.length === 0) return;
  markBootStage('restored-session-read');
  for (const sessionId of sessionIds) void requestSessionRead(sessionId, { speculative: true });
}
