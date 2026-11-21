import { useEffect, useMemo, useRef } from 'react';
import { onStudioAssetsMoved, refreshStudioBoards, type StudioBoard } from './studio-boards';
import type { StudioMediaJob, useStudioAssetGallery } from './studio-media-state';
import { MEDIA_KINDS, type MediaAsset, type StudioApi } from './studio-support';
import { errorMessage } from './editor-pane-session-errors';

type AssetGallery = ReturnType<typeof useStudioAssetGallery>;

/** Keeps the gallery and the board counts in step with the open board and the
 *  runs landing in it; returns the runs that belong to the open board. */
export function useStudioBoardSync({
  active,
  allCount,
  api,
  boardId,
  boards,
  boardsLoaded,
  exitSelection,
  jobs,
  loadedTotal,
  moveAssets,
  refreshAssetKind,
  runningKey,
  setError,
  setSelected,
  syncAssetKind,
}: {
  active: boolean;
  allCount: number;
  api: StudioApi;
  boardId: string;
  boards: StudioBoard[];
  boardsLoaded: boolean;
  exitSelection: () => void;
  jobs: StudioMediaJob[];
  loadedTotal: AssetGallery['loadedTotal'];
  moveAssets: AssetGallery['moveAssets'];
  refreshAssetKind: AssetGallery['refreshAssetKind'];
  runningKey: string;
  setError: (message: string) => void;
  setSelected: (asset: MediaAsset | null) => void;
  syncAssetKind: AssetGallery['syncAssetKind'];
}): StudioMediaJob[] {
  // Another board opened: the gallery reads that board from its first page.
  const shownBoardRef = useRef(boardId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the board id is the trigger
  useEffect(() => {
    if (shownBoardRef.current === boardId) return;
    shownBoardRef.current = boardId;
    exitSelection();
    setSelected(null);
    if (!active) return;
    Promise.all(MEDIA_KINDS.map((assetKind) => refreshAssetKind(assetKind))).catch((reason) =>
      setError(errorMessage(reason))
    );
  }, [boardId, active]);
  useEffect(() => onStudioAssetsMoved(moveAssets), [moveAssets]);
  // A finished run changes its board's count and thumbnail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runningKey is the trigger
  useEffect(() => {
    if (active) void refreshStudioBoards(api).catch(() => {});
  }, [active, api, runningKey]);
  // A board view lists only the runs that land in it.
  const boardJobs = useMemo(
    () => (boardId ? jobs.filter((entry) => (entry.request?.boardId ?? '') === boardId) : jobs),
    [jobs, boardId]
  );
  // The count the panel shows for this view; when it moves away from what the
  // loaded pages were counted at, results came from elsewhere (the agent media
  // tool, another window or device): fold them in, keeping loaded pages. A run
  // of this view's own is still landing, so that waits until it settles.
  const shownCount = boardId ? boards.find((board) => board.id === boardId)?.count : allCount;
  const viewRunning = boardJobs.some((entry) => entry.status === 'running');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shown count and the run settling are the triggers
  useEffect(() => {
    if (!active || !boardsLoaded || shownCount === undefined || viewRunning) return;
    const known = loadedTotal();
    if (known === null || known === shownCount) return;
    for (const assetKind of MEDIA_KINDS) void syncAssetKind(assetKind).catch(() => {});
  }, [active, boardsLoaded, shownCount, viewRunning]);
  return boardJobs;
}
