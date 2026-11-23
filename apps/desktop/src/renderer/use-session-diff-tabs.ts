import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { pendingSessionDiffFileRequest, type SessionDiffFileRequest } from './session-diff-focus';
import type { SessionDiffRow } from './session-diff-model';
import { rowListIndex } from './session-diff-row-index';
import { normalizeChangePath } from './turn-changes-model';

/** The panel's open file tabs, drawn next to the Changes tab. */
export type SessionDiffFileTabs = {
  tabs: readonly { key: string; name: string; title: string }[];
  onSelect(key: string): void;
  onClose(key: string): void;
};

/** Sessions whose strip shows neither "Changes" nor a diff file tab. */
const emptyStrips = new Set<string>();
const emptyStripListeners = new Set<() => void>();
function setStripEmpty(sessionId: string, empty: boolean): void {
  if (empty) emptyStrips.add(sessionId);
  else emptyStrips.delete(sessionId);
  for (const listener of emptyStripListeners) listener();
}
function subscribeEmptyStrips(listener: () => void): () => void {
  emptyStripListeners.add(listener);
  return () => {
    emptyStripListeners.delete(listener);
  };
}

/** False once the session's "Changes" and diff file tabs are all closed, so
 *  closing the last side file tab ends the dock. */
export function sessionDiffStripHasTabs(sessionId: string): boolean {
  return !emptyStrips.has(sessionId);
}

/** `sessionDiffStripHasTabs`, re-rendering when it changes. */
export function useSessionDiffStripHasTabs(sessionId: string): boolean {
  return useSyncExternalStore(subscribeEmptyStrips, () => sessionDiffStripHasTabs(sessionId));
}

/** The pane's tab strip state. A file opened from the transcript gets its own
 *  tab beside "Changes", showing that one file's whole diff; "Changes"
 *  (island, View changes, reopen) shows every file. `focusPath` is the
 *  selected file tab ('' = Changes). */
export function useSessionDiffTabs({
  sessionId,
  active,
  bodyRef,
  fileTabs,
  onClose,
  onSessionChange,
}: {
  sessionId: string;
  active: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  fileTabs?: SessionDiffFileTabs;
  onClose?(): void;
  /** Resets the rest of the pane when the session changes. */
  onSessionChange(): void;
}) {
  const [diffTabs, setDiffTabs] = useState<readonly string[]>([]);
  const [focusPath, setFocusPath] = useState('');
  const [changesOpen, setChangesOpen] = useState(() => !pendingSessionDiffFileRequest(sessionId)?.path);
  const showAllFiles = () => {
    setChangesOpen(true);
    setFocusPath('');
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const openDiffTab = (path: string) => {
    setDiffTabs((current) => (current.includes(path) ? current : [...current, path]));
    setFocusPath(path);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  // Closing the panel's last tab closes the side panel itself (back to the
  // conversation alone); the next open starts on "Changes" again.
  const closePanel = () => {
    setChangesOpen(true);
    setFocusPath('');
    onClose?.();
  };
  const otherSurfaceTabs = fileTabs?.tabs.length ?? 0;
  const closeDiffTab = (path: string) => {
    const remaining = diffTabs.filter((entry) => entry !== path);
    setDiffTabs(remaining);
    if (!changesOpen && remaining.length === 0 && otherSurfaceTabs === 0) {
      closePanel();
      return;
    }
    if (focusPath !== path) return;
    if (changesOpen) showAllFiles();
    else if (remaining.length > 0) openDiffTab(remaining.at(-1) as string);
    else if (fileTabs?.tabs.length) fileTabs.onSelect(fileTabs.tabs[0].key);
  };
  const closeChanges = () => {
    if (diffTabs.length === 0 && otherSurfaceTabs === 0) {
      closePanel();
      return;
    }
    setChangesOpen(false);
    if (!focusPath && diffTabs.length > 0) openDiffTab(diffTabs.at(-1) as string);
    else if (!focusPath && fileTabs?.tabs.length) fileTabs.onSelect(fileTabs.tabs[0].key);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets once per session change; onSessionChange only calls stable setters
  useEffect(() => {
    onSessionChange();
    setDiffTabs([]);
    setFocusPath('');
    setChangesOpen(!pendingSessionDiffFileRequest(sessionId)?.path);
  }, [sessionId]);
  const wasActive = useRef(active);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs only when the pane is shown again; the session and the reset actions are read at that moment
  useLayoutEffect(() => {
    if (active && !wasActive.current) {
      setDiffTabs([]);
      if (pendingSessionDiffFileRequest(sessionId)?.path) {
        setChangesOpen(false);
        setFocusPath('');
      } else {
        showAllFiles();
      }
    }
    wasActive.current = active;
  }, [active]);
  const stripEmpty = !changesOpen && diffTabs.length === 0;
  useEffect(() => {
    if (!stripEmpty) return undefined;
    setStripEmpty(sessionId, true);
    return () => setStripEmpty(sessionId, false);
  }, [sessionId, stripEmpty]);
  return {
    diffTabs,
    focusPath,
    changesOpen,
    setChangesOpen,
    otherSurfaceTabs,
    showAllFiles,
    openDiffTab,
    closeDiffTab,
    closeChanges,
  };
}

/** What the tab strip and the body show for the current tabs and request. */
export function sessionDiffTabView({
  rows,
  diffTabs,
  focusPath,
  changesOpen,
  fileRequest,
  otherSurfaceTabs,
}: {
  rows: readonly SessionDiffRow[];
  diffTabs: readonly string[];
  focusPath: string;
  changesOpen: boolean;
  fileRequest: SessionDiffFileRequest | null;
  otherSurfaceTabs: number;
}) {
  // The list's shared index (built when the list was adopted).
  const { byPath } = rowListIndex(rows);
  const rowAt = (path: string) => rows[byPath.get(path) ?? -1];
  const focusRow = focusPath ? (rowAt(focusPath) ?? null) : null;
  // A file tab whose file left the diff is not drawn.
  const tabRows = diffTabs.flatMap((path) => rowAt(path) ?? []);
  const awaitingFile = !changesOpen && tabRows.length === 0 && Boolean(fileRequest);
  const showChanges = changesOpen || (tabRows.length === 0 && !fileRequest && otherSurfaceTabs === 0);
  // The file being read already has its tab and its name in row 2; only the
  // body shows loading until its diff arrives.
  const pendingPath = awaitingFile && fileRequest ? normalizeChangePath(fileRequest.path) : '';
  let visibleRows: readonly SessionDiffRow[] = [];
  if (focusRow) visibleRows = [focusRow];
  else if (showChanges) visibleRows = rows;
  return { focusRow, tabRows, awaitingFile, showChanges, pendingPath, visibleRows };
}
