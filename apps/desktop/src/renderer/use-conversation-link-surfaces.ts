import { useCallback, useMemo, useRef } from 'react';
import type { TurnChangesSurface } from './TurnChangesCard';

type OpenFile = (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
type OpenFolder = (project: string, rel: string) => void;

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
  }: {
    /** Empty where no changed-files card may mount (drafts, read-only views). */
    turnChangesSessionId: string;
    turnChangesBusy: boolean;
    turnChangesRunning: boolean;
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
      onOpenSessionDiff: hasSessionDiffRoute ? stableOpenSessionDiff : undefined,
      onOpenFile: openFile,
    };
  }, [turnChangesSessionId, turnChangesBusy, turnChangesRunning, hasSessionDiffRoute, stableOpenSessionDiff, openFile]);
  return { openFile, openFolder, turnChangesSurface };
}
