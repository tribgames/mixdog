import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { pendingSessionDiffFileRequest, type SessionDiffFileRequest } from './session-diff-focus';
import type { SessionDiffRow } from './session-diff-model';
import { normalizeChangePath } from './turn-changes-model';

/** The panel's open file tabs, drawn next to the Changes tab. */
export type SessionDiffFileTabs = {
  tabs: readonly { key: string; name: string; title: string }[];
  onSelect(key: string): void;
  onClose(key: string): void;
};

/** Sessions whose strip shows neither "Changes" nor a diff file tab. */
const emptyStrips = new Set<string>();

/** False once the session's "Changes" and diff file tabs are all closed, so
 *  closing the last side file tab ends the dock. */
export function sessionDiffStripHasTabs(sessionId: string): boolean {
  return !emptyStrips.has(sessionId);
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
  // "Changes" closes like any tab; asking for the changes again reopens it.
  // A pane opened by one file (a turn card's row) starts with that file's tab
  // only; any other way in (View changes, the island, the header) starts on
  // "Changes".
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
  // Reopening a hidden pane starts fresh: on "Changes" at the top, or — when
  // one file is what opened it — on that file's tab alone. A layout effect, so
  // the previous visit's tabs never paint for a frame before the reset.
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
    emptyStrips.add(sessionId);
    return () => {
      emptyStrips.delete(sessionId);
    };
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
  const focusRow = focusPath ? (rows.find((row) => row.path === focusPath) ?? null) : null;
  // A file tab whose file left the diff is not drawn.
  const tabRows = diffTabs.flatMap((path) => rows.filter((row) => row.path === path));
  // Never a blank pane: while the file that opened it is still being read
  // the body shows the loading surface; with no file tab and nothing
  // pending, "Changes" stands in.
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
