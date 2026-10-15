import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, DesktopCapability } from '../../shared/contract';
import {
  isConversationImportJobActive,
  type ConversationImportJob,
  type ConversationImportList,
  type ConversationImportRow,
  type ConversationImportSelection,
  type ConversationImportSource,
} from '../../shared/contract-import';
import { t } from '../i18n';
import { OPEN_IMPORTED_SESSION_EVENT, type OpenImportedSessionDetail } from '../import-conversation-events';
import { importJobStore } from '../import-job-store';
import {
  EMPTY_IMPORT_SELECTION,
  importCodeFromError,
  importCodeMessage,
  importModifiedAfter,
  isKnownProject,
  isRowSelectable,
  isRowSelected,
  selectAllState,
  selectedImportCount,
  type ImportSelectionState,
  type ImportTimeRange,
} from './import-conversations-model';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const SCAN_REFRESH_MS = 1500;
const JOB_POLL_MS = 2000;

export type ImportJobMode = 'single' | 'batch';

export type ImportApi = Partial<DesktopApi> &
  Pick<DesktopApi, 'invokeCapability' | 'readCapabilities' | 'listProjects' | 'addProject'>;

export const desktopApi = (): ImportApi | undefined =>
  (window as unknown as { mixdogDesktop?: ImportApi }).mixdogDesktop;

async function readImport<T>(api: ImportApi, capability: 'listImportableConversations', input: unknown): Promise<T> {
  const [result] = await api.readCapabilities([{ capability, args: [input] }]);
  if (!result?.ok) throw new Error(result?.error ?? 'Import read failed.');
  return result.value as T;
}

async function callImport<T>(api: ImportApi, capability: DesktopCapability, input: unknown) {
  return (await api.invokeCapability<T>({ capability, args: [input] })).value;
}

/** A progress snapshot replaces the tracked job of the same id (never an older one);
 *  with no tracked job only a running one is adopted. */
export function adoptImportJob(current: ConversationImportJob | null, next: ConversationImportJob) {
  if (current) return current.jobId === next.jobId && next.seq >= current.seq ? next : current;
  return isConversationImportJobActive(next) ? next : current;
}

function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Filters, paged listing, scan refresh, selection and the pinned chosen file. */
export function useImportListing(api: ImportApi | undefined) {
  const mountedRef = useMountedRef();
  const [source, setSource] = useState<ConversationImportSource>('codex');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const [project, setProject] = useState('');
  const [range, setRange] = useState<ImportTimeRange>('all');
  const [list, setList] = useState<ConversationImportList | null>(null);
  const [projectOptions, setProjectOptions] = useState<ConversationImportList['projects']>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState(false);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<ImportSelectionState>(EMPTY_IMPORT_SELECTION);
  const [pinned, setPinned] = useState<ConversationImportRow | null>(null);
  const viewIdRef = useRef('');
  const pinnedRef = useRef<ConversationImportRow | null>(null);
  pinnedRef.current = pinned;

  const request = useCallback(
    (cursor?: string) => ({
      source,
      ...(debouncedQuery ? { query: debouncedQuery } : {}),
      ...(project ? { project } : {}),
      ...(range !== 'all' ? { modifiedAfter: importModifiedAfter(range) } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    }),
    [source, debouncedQuery, project, range]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` is the explicit refresh trigger.
  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    setLoading(true);
    void readImport<ConversationImportList>(api, 'listImportableConversations', request())
      .then((next) => {
        if (!live) return;
        if (next.viewId !== viewIdRef.current) {
          viewIdRef.current = next.viewId;
          // A new view drops the selection, except a chosen file pinned outside the view.
          const pinnedId = pinnedRef.current?.id;
          setSelection((current) =>
            pinnedId && !current.all && current.ids.has(pinnedId)
              ? { all: false, ids: new Set([pinnedId]) }
              : EMPTY_IMPORT_SELECTION
          );
        }
        if (!project) setProjectOptions(next.projects);
        setList(next);
        setListError(false);
      })
      .catch(() => live && setListError(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, request, project, reload]);

  // The displayed list answers the current filters only once its refresh has settled;
  // until then a selection (made on the previous list) is neither shown as valid nor actionable.
  const settled = list !== null && !loading && query.trim() === debouncedQuery;
  const selectableCount = list?.selectableCount ?? 0;
  const rawSelectedCount = selectedImportCount(selection, selectableCount);
  const selectedCount = settled ? rawSelectedCount : 0;
  // Keep the timer pause tied to the raw selection so a refresh never drops a pick silently.
  const selectionEmpty = rawSelectedCount === 0;
  // A select-all selection is only countable once the scan found everything.
  const canSelectAll = settled && list?.complete === true;

  // Each fresh list object re-arms the timer, so an unfinished scan keeps refreshing.
  useEffect(() => {
    if (!list || list.complete || !selectionEmpty) return undefined;
    const timer = setTimeout(() => setReload((value) => value + 1), SCAN_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [list, selectionEmpty]);

  const loadMore = useCallback(() => {
    if (!api || !list?.nextCursor || loadingMore || loading) return;
    const { viewId, nextCursor } = list;
    setLoadingMore(true);
    void readImport<ConversationImportList>(api, 'listImportableConversations', request(nextCursor))
      .then((page) => {
        if (!mountedRef.current || viewIdRef.current !== viewId) return;
        setList((current) =>
          current && current.viewId === viewId
            ? {
                ...current,
                rows: [...current.rows, ...page.rows],
                nextCursor: page.nextCursor,
                complete: page.complete,
              }
            : current
        );
      })
      .catch(() => mountedRef.current && setListError(true))
      .finally(() => mountedRef.current && setLoadingMore(false));
  }, [api, list, loading, loadingMore, request, mountedRef]);

  // A changed filter starts a new view: picks made on the old one are dropped now, except a chosen file.
  const keepPinnedSelection = () =>
    setSelection(pinnedRef.current ? { all: false, ids: new Set([pinnedRef.current.id]) } : EMPTY_IMPORT_SELECTION);
  const changeQuery = (value: string) => {
    keepPinnedSelection();
    setQuery(value);
  };
  const changeProject = (value: string) => {
    keepPinnedSelection();
    setProject(value);
  };
  const changeRange = (value: ImportTimeRange) => {
    keepPinnedSelection();
    setRange(value);
  };

  const selectSource = (value: ConversationImportSource) => {
    if (value === source) return;
    viewIdRef.current = '';
    setSource(value);
    setProject('');
    setPinned(null);
    setProjectOptions([]);
    setList(null);
    setSelection(EMPTY_IMPORT_SELECTION);
  };

  /** Pins a natively chosen file; resolves to an error message ('' when fine or cancelled). */
  const chooseFile = async (): Promise<string> => {
    if (!api?.chooseConversationImportFile) return '';
    try {
      const path = await api.chooseConversationImportFile();
      if (!path) return '';
      const { row } = await callImport<{ row: ConversationImportRow }>(api, 'registerConversationImportFile', {
        source,
        path,
      });
      if (!isRowSelectable(row)) return t('This conversation was already imported.');
      setPinned(row);
      setSelection({ all: false, ids: new Set([row.id]) });
      return '';
    } catch (failure) {
      const localOnly = t('Importing conversations is available only on this PC.');
      if (failure instanceof Error && failure.message.includes(localOnly)) return localOnly;
      return importCodeMessage(importCodeFromError(failure));
    }
  };

  // A chosen file is pinned above the scanned rows (never listed twice).
  const rows = pinned ? [pinned, ...(list?.rows ?? []).filter((row) => row.id !== pinned.id)] : (list?.rows ?? []);
  const filtered = Boolean(debouncedQuery || project || range !== 'all');
  const showEmpty = Boolean(list?.complete && list.matchedCount === 0) && !filtered && !listError && !pinned;
  // "Import and continue" needs exactly one selected conversation whose row is on screen.
  const singleRow =
    selectedCount === 1 ? (rows.find((row) => isRowSelected(selection, row) && isRowSelectable(row)) ?? null) : null;

  return {
    source,
    query,
    setQuery: changeQuery,
    project,
    setProject: changeProject,
    range,
    setRange: changeRange,
    settled,
    canSelectAll,
    singleRow,
    list,
    projectOptions,
    loading,
    loadingMore,
    listError,
    selection,
    setSelection,
    pinned,
    rows,
    selectableCount,
    selectedCount,
    allState: selectAllState(selection, selectableCount),
    scanning: list !== null && !list.complete,
    showEmpty,
    loadMore,
    selectSource,
    chooseFile,
  };
}

export type ImportListing = ReturnType<typeof useImportListing>;

/** The tracked import job: starting, adoption from the store/runtime, polling, stopping and,
 *  for a single import, continuing into the imported session. */
export function useImportJob(api: ImportApi | undefined, onClose: () => void) {
  const mountedRef = useMountedRef();
  const [job, setJob] = useState<ConversationImportJob | null>(null);
  const [jobMode, setJobMode] = useState<ImportJobMode>('batch');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const singleRowRef = useRef<ConversationImportRow | null>(null);
  const finishedRef = useRef('');

  // A job started earlier (or from another window), or a finished one nobody has dismissed yet.
  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    importJobStore.start();
    const unacknowledged = importJobStore.get();
    if (unacknowledged) {
      setJobMode('batch');
      setJob(unacknowledged);
    }
    void callImport<{ jobs?: ConversationImportJob[] }>(api, 'getConversationImportJobs', {})
      .then((value) => {
        const active = value?.jobs?.find(isConversationImportJobActive);
        if (live && active) {
          setJobMode('batch');
          setJob((current) => adoptImportJob(current, active));
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.subscribeConversationImportProgress?.((next) => {
      if (live) setJob((current) => adoptImportJob(current, next));
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api]);

  // Safety net for a missed progress event while a job is tracked.
  const trackedId = job && isConversationImportJobActive(job) ? job.jobId : '';
  useEffect(() => {
    if (!api || !trackedId) return undefined;
    const timer = setInterval(() => {
      void callImport<{ jobs?: ConversationImportJob[] }>(api, 'getConversationImportJobs', { jobId: trackedId })
        .then((value) => {
          const next = value?.jobs?.find((entry) => entry.jobId === trackedId);
          if (next && mountedRef.current) setJob((current) => adoptImportJob(current, next));
        })
        .catch(() => undefined);
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [api, trackedId, mountedRef]);

  useEffect(() => {
    if (!api || !job || jobMode !== 'single' || isConversationImportJobActive(job)) return;
    if (finishedRef.current === job.jobId) return;
    finishedRef.current = job.jobId;
    importJobStore.acknowledge(job.jobId);
    const result = job.results.find((entry) => entry.sessionId);
    if (!result?.sessionId) {
      setError(importCodeMessage(job.errorCode ?? job.results.find((entry) => entry.status === 'failed')?.errorCode));
      setJob(null);
      return;
    }
    const sessionId = result.sessionId;
    const cwd = singleRowRef.current?.cwd ?? null;
    void (async () => {
      // The session's project must be a known project before it is opened.
      if (cwd) {
        try {
          if (!isKnownProject(await api.listProjects(), cwd)) await api.addProject(cwd);
        } catch {
          /* a missing folder still opens the session under its recorded path */
        }
      }
      if (!mountedRef.current) return;
      window.dispatchEvent(
        new CustomEvent<OpenImportedSessionDetail>(OPEN_IMPORTED_SESSION_EVENT, { detail: { sessionId } })
      );
      onClose();
    })();
  }, [api, job, jobMode, onClose, mountedRef]);

  const start = async (
    selection: ConversationImportSelection,
    single: boolean,
    singleRow: ConversationImportRow | null
  ) => {
    if (!api || starting) return;
    singleRowRef.current = singleRow;
    setError('');
    setStarting(true);
    try {
      const started = await callImport<ConversationImportJob>(api, 'startConversationImport', {
        requestId: crypto.randomUUID(),
        selection,
      });
      if (!mountedRef.current) return;
      setJobMode(single ? 'single' : 'batch');
      setJob(started);
    } catch (failure) {
      if (mountedRef.current) setError(importCodeMessage(importCodeFromError(failure)));
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const stop = () => {
    if (!api || !job) return;
    void callImport<ConversationImportJob>(api, 'cancelConversationImport', { jobId: job.jobId })
      .then((next) => mountedRef.current && setJob((current) => adoptImportJob(current, next)))
      .catch(() => undefined);
  };

  return { job, jobMode, starting, error, setError, start, stop };
}
