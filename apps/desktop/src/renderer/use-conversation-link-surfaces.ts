import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TurnChangesSurface } from './TurnChangesCard';
import { forgetTurnPreviewMarks, noteTurnRunning } from './turn-preview-model';

type OpenFile = (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
type OpenFolder = (project: string, rel: string) => void;

/** Whether the card on the transcript's last turn end (its `trailing` one) belongs to a turn still running: it then
 *  stays hidden and unread. It does through the turn's own end until the session is idle: the record is readable once
 *  the turn has let go of it, not when its end is written. It does not once that end is passed (`pastLastEnd`,
 *  use-conversation-rows.ts; for the running turn's key, `turnPastEnd`: nothing of it has settled): the card is the
 *  ended turn's, already read. */
export function trailingTurnRuns(busy: unknown, pendingPrompts: number, turnPastEnd: boolean): boolean {
  return Boolean(busy) && pendingPrompts === 0 && !turnPastEnd;
}

/** Context values for transcript rows and file links: stable openers and the
 *  per-turn changed-files surface. */
export function useConversationLinkSurfaces(
  {
    onOpenFile,
    onOpenFolder,
    onOpenSessionDiff,
  }: {
    onOpenFile?: OpenFile;
    onOpenFolder?: OpenFolder;
    onOpenSessionDiff?: () => void;
  },
  {
    turnChangesSessionId,
    turnChangesBusy,
    turnChangesRunning,
    trailingCheckpointShown,
    runningTurnKey = '',
  }: {
    /** Empty where no changed-files card may mount (drafts, read-only views). */
    turnChangesSessionId: string;
    turnChangesBusy: boolean;
    turnChangesRunning: boolean;
    /** Whether the trailing card's checkpoint already stood while the session was idle. */
    trailingCheckpointShown?: boolean;
    /** The turn key of the running turn (its settled prompt's), while it runs. */
    runningTurnKey?: string;
  }
) {
  // Context consumers (every transcript row and file link) keep their memo:
  // the providers get a stable opener that calls the latest prop.
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const stableOpenFile = useCallback<OpenFile>((...args) => openFileRef.current?.(...args), []);
  const openFile = onOpenFile ? stableOpenFile : undefined;
  const openFolderRef = useRef(onOpenFolder);
  openFolderRef.current = onOpenFolder;
  const stableOpenFolder = useCallback<OpenFolder>((...args) => openFolderRef.current?.(...args), []);
  const openFolder = onOpenFolder ? stableOpenFolder : undefined;
  const openSessionDiffRef = useRef(onOpenSessionDiff);
  openSessionDiffRef.current = onOpenSessionDiff;
  const stableOpenSessionDiff = useCallback(() => openSessionDiffRef.current?.(), []);
  const hasSessionDiffRoute = Boolean(onOpenSessionDiff);
  const turnChangesSurface = useMemo<TurnChangesSurface | null>(() => {
    if (!turnChangesSessionId) return null;
    return {
      sessionId: turnChangesSessionId,
      busy: turnChangesBusy,
      turnRunning: turnChangesRunning,
      trailingCheckpointShown,
      onOpenSessionDiff: hasSessionDiffRoute ? stableOpenSessionDiff : undefined,
      onOpenFile: openFile,
    };
  }, [
    turnChangesSessionId,
    turnChangesBusy,
    turnChangesRunning,
    trailingCheckpointShown,
    hasSessionDiffRoute,
    stableOpenSessionDiff,
    openFile,
  ]);
  // The turn seen running here: its own end may open its previews
  // (turn-preview-model.ts).
  useEffect(() => {
    noteTurnRunning(turnChangesSessionId, runningTurnKey);
  }, [turnChangesSessionId, runningTurnKey]);
  // A reconnect (pushes may have been missed, the turn may have ended
  // unseen) or leaving the session drops its marks.
  useEffect(() => {
    if (!turnChangesSessionId) return undefined;
    const forget = () => forgetTurnPreviewMarks(turnChangesSessionId);
    window.addEventListener('mixdog:remote-reconnected', forget);
    window.addEventListener('mixdog:remote-state-gap', forget);
    return () => {
      window.removeEventListener('mixdog:remote-reconnected', forget);
      window.removeEventListener('mixdog:remote-state-gap', forget);
      forget();
    };
  }, [turnChangesSessionId]);
  return { openFile, openFolder, turnChangesSurface };
}
