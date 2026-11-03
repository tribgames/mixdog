import { useEffect, useSyncExternalStore } from 'react';
import { t } from './i18n';
import { callCapability, type StudioApi } from './studio-support';

// Studio boards: user-named collections of results, kept by the runtime's
// media store. One board is open at a time ('' = "전체", every result): the
// rail panel opens it, every Studio pane shows it, and new generations join it.

export interface StudioBoard {
  id: string;
  name: string;
  createdAt: number;
  count: number;
}

interface StudioBoardsState {
  loaded: boolean;
  /** Every result's count ("전체"). */
  total: number;
  boards: StudioBoard[];
  /** The open board's id, '' for "전체". */
  openId: string;
}

const OPEN_BOARD_KEY = 'mixdog.studio.openBoard';

function storedOpenId(): string {
  try {
    return window.localStorage.getItem(OPEN_BOARD_KEY) || '';
  } catch {
    return '';
  }
}

let state: StudioBoardsState = { loaded: false, total: 0, boards: [], openId: '' };
let openIdRead = false;
const listeners = new Set<() => void>();
const movedListeners = new Set<(ids: readonly string[], boardId: string) => void>();
let refreshing: Promise<void> | null = null;
let queuedRefresh: Promise<void> | null = null;

function update(patch: Partial<StudioBoardsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): StudioBoardsState {
  if (!openIdRead) {
    openIdRead = true;
    state = { ...state, openId: storedOpenId() };
  }
  return state;
}

/** Re-reads the board list (counts, total). A read in flight may have
 *  been answered before a mutation landed, so by default the new read queues
 *  behind it (several callers share one queued read); `join` only for callers
 *  that want any current list, such as a view becoming visible. */
export function refreshStudioBoards(api: StudioApi | undefined, { join = false } = {}): Promise<void> {
  if (refreshing && !join) {
    queuedRefresh ??= refreshing
      .catch(() => {})
      .then(() => {
        queuedRefresh = null;
        return refreshStudioBoards(api, { join: true });
      });
    return queuedRefresh;
  }
  refreshing ??= (async () => {
    try {
      const result = (await callCapability(api, 'listMediaBoards')) as
        | { total?: number; boards?: StudioBoard[] }
        | undefined;
      const boards = Array.isArray(result?.boards) ? result.boards : [];
      const current = snapshot();
      // A board deleted elsewhere (or a stale remembered one) falls back to "전체".
      const openId = boards.some((board) => board.id === current.openId) ? current.openId : '';
      if (openId !== current.openId) rememberOpenId(openId);
      update({ loaded: true, total: Number(result?.total) || 0, boards, openId });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function rememberOpenId(id: string): void {
  try {
    if (id) window.localStorage.setItem(OPEN_BOARD_KEY, id);
    else window.localStorage.removeItem(OPEN_BOARD_KEY);
  } catch {
    // The open board is a convenience across restarts.
  }
}

export function openStudioBoard(id: string): void {
  snapshot();
  if (id === state.openId) return;
  rememberOpenId(id);
  update({ openId: id });
}

/** The boards and the open one; reads the list while `active`. */
export function useStudioBoards(api: StudioApi | undefined, active: boolean): StudioBoardsState {
  const current = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (active) void refreshStudioBoards(api, { join: true }).catch(() => {});
  }, [active, api]);
  return current;
}

export function useOpenStudioBoardId(): string {
  return useSyncExternalStore(subscribe, () => snapshot().openId);
}

/** A Studio tab's title: the open board's name, "전체" when none is open. A
 *  remembered board reads the list once so the restored tab names it. */
export function useStudioBoardTitle(api: StudioApi | undefined = window.mixdogDesktop): string {
  const current = useSyncExternalStore(subscribe, snapshot);
  const pending = Boolean(current.openId) && !current.loaded;
  useEffect(() => {
    if (pending) void refreshStudioBoards(api, { join: true }).catch(() => {});
  }, [pending, api]);
  if (!current.openId) return t('All');
  return current.boards.find((board) => board.id === current.openId)?.name ?? t('Studio');
}

export async function createStudioBoard(api: StudioApi | undefined, name: string): Promise<StudioBoard | null> {
  const board = (await callCapability(api, 'createMediaBoard', [name])) as StudioBoard | undefined;
  await refreshStudioBoards(api);
  return board ?? null;
}

export async function renameStudioBoard(api: StudioApi | undefined, id: string, name: string): Promise<void> {
  await callCapability(api, 'renameMediaBoard', [id, name]);
  await refreshStudioBoards(api);
}

export async function deleteStudioBoard(api: StudioApi | undefined, id: string): Promise<void> {
  await callCapability(api, 'deleteMediaBoard', [id]);
  if (state.openId === id) openStudioBoard('');
  await refreshStudioBoards(api);
}

/** Moves results into `boardId` ('' = out of any board, sent as null); every pane hears it. */
export async function moveStudioAssets(
  api: StudioApi | undefined,
  ids: readonly string[],
  boardId: string
): Promise<void> {
  await callCapability(api, 'setMediaAssetBoard', [[...ids], boardId || null]);
  await refreshStudioBoards(api);
  for (const listener of movedListeners) listener(ids, boardId);
}

/** Results `ids` moved to `boardId`. */
export function onStudioAssetsMoved(listener: (ids: readonly string[], boardId: string) => void): () => void {
  movedListeners.add(listener);
  return () => movedListeners.delete(listener);
}
