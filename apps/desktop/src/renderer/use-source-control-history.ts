// Commit history for the dock: the windowed, scroll-paged log plus the
// selected commit's detail state.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopGitCommitDetails, DesktopGitLogEntry } from '../shared/contract';
import { HISTORY_PAGE_SIZE, HISTORY_PREFETCH_ROWS, SCM_COMMIT_ROW_HEIGHT, useRowWindow } from './source-control-support';

export function useSourceControlHistory({
  api,
  projectPath,
  active,
  listing,
  windowed,
  setError,
}: {
  api: Window['mixdogDesktop'];
  projectPath: string;
  active: boolean;
  /** The history view is showing, so the log loads (and reloads on query). */
  listing: boolean;
  /** Rows are windowed against the scroll container. */
  windowed: boolean;
  setError: (message: string) => void;
}) {
  const [history, setHistory] = useState<DesktopGitLogEntry[]>([]);
  const historyRef = useRef<DesktopGitLogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  /** The commit count the scroll pager last requested a page FOR. A page that
   *  turns out to be all duplicates leaves the length unchanged, and without
   *  this the same skip would be re-requested forever. */
  const autoPagedSkip = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedCommit, setSelectedCommit] = useState('');
  const [commitDetail, setCommitDetail] = useState<DesktopGitCommitDetails | null>(null);
  /** Outcome of the last SHA copy — the copy affordance's confirmation.
   *  `ok: false` means the clipboard was unavailable or refused, which must
   *  NOT read as "Copied". */
  const [shaCopy, setShaCopy] = useState<{ hash: string; ok: boolean } | null>(null);
  const [openCommitFile, setOpenCommitFile] = useState('');
  const [commitDiffs, setCommitDiffs] = useState<Record<string, string | null>>({});

  const loadHistory = useCallback(
    async (reset = true) => {
      if (!active || !projectPath || !api?.gitLog) return;
      const skip = reset ? 0 : historyRef.current.length;
      if (reset) autoPagedSkip.current = -1;
      setLoading(true);
      try {
        const page = await api.gitLog(projectPath, query, skip, HISTORY_PAGE_SIZE);
        const next = reset
          ? page
          : [
              ...historyRef.current,
              ...page.filter((entry) => !historyRef.current.some((existing) => existing.hash === entry.hash)),
            ];
        historyRef.current = next;
        setHistory(next);
        setHasMore(page.length === HISTORY_PAGE_SIZE);
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [active, api, query, projectPath, setError]
  );
  useEffect(() => {
    setHistory([]);
    historyRef.current = [];
    setSelectedCommit('');
    setCommitDetail(null);
    setOpenCommitFile('');
    setCommitDiffs({});
    setQuery('');
    setHasMore(false);
  }, [projectPath]);
  useEffect(() => {
    if (!listing) return undefined;
    const timer = window.setTimeout(() => void loadHistory(true), historyRef.current.length ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [listing, query, loadHistory]);
  const rowWindow = useRowWindow(
    scrollRef,
    SCM_COMMIT_ROW_HEIGHT,
    history.length,
    windowed && !selectedCommit,
    `${projectPath}\u0000${query}`
  );
  /** Scrolling IS the history pager now: the next `gitLog` page is fetched as
   *  the window approaches the end of the loaded commits, so the incremental
   *  fetch survives without a `Load more` button. */
  useEffect(() => {
    if (!rowWindow.measured || !hasMore || loading) return;
    if (rowWindow.end < history.length - HISTORY_PREFETCH_ROWS) return;
    if (autoPagedSkip.current === history.length) return;
    autoPagedSkip.current = history.length;
    void loadHistory(false);
  }, [history.length, hasMore, loading, rowWindow, loadHistory]);

  const closeCommit = useCallback(() => {
    setSelectedCommit('');
    setCommitDetail(null);
    setOpenCommitFile('');
    setCommitDiffs({});
    setShaCopy(null);
  }, []);

  return {
    entries: history,
    visibleEntries: history.slice(rowWindow.start, rowWindow.end),
    rowWindow,
    scrollRef,
    query,
    setQuery,
    loading,
    setLoading,
    loadHistory,
    selectedCommit,
    setSelectedCommit,
    commitDetail,
    setCommitDetail,
    shaCopy,
    setShaCopy,
    openCommitFile,
    setOpenCommitFile,
    commitDiffs,
    setCommitDiffs,
    closeCommit,
  };
}
