import { RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SESSION_DIFF_STYLE_KEY } from './desktop-types';
import { diffModeActions, useDiffViewState, type DiffViewState } from './diff-header-controls';
import { DockHeaderRow, type DockAction } from './pane-dock-chrome';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import { OpenSelect } from './OpenSelect';
import {
  SESSION_CHANGES_SOURCES,
  sessionChangesEmptyText,
  sessionChangesSourceLabel,
  useSessionChangePatches,
  type SessionChangesSource,
} from './session-changes-store';
import { gitRowOpenPath } from './session-diff-model';
import { SessionDiffScope } from './session-diff-scope';
import { SessionDiffStack, sessionDiffBodyPending } from './session-diff-section';
import { SessionDiffTabStrip } from './session-diff-tab-strip';
import { useSessionDiffCollapse } from './use-session-diff-collapse';
import { useSessionDiffRequests } from './use-session-diff-requests';
import { useSessionDiffRevert } from './use-session-diff-revert';
import { useSessionDiffRows } from './use-session-diff-rows';
import { sessionDiffTabView, useSessionDiffTabs, type SessionDiffFileTabs } from './use-session-diff-tabs';

/** Every state renders inside the same flex-column frame, so an empty, loading
 *  or failed pane centres its message on both axes exactly like the other
 *  dock panes. */
function SessionDiffFrame({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
}) {
  return (
    <section className="session-diff-pane" aria-label={t('Session diff')} onKeyDown={onKeyDown}>
      {children}
    </section>
  );
}

/** A Git root's Changes source picker (the composer chip follows it too). */
function SessionChangesSourceSelect({
  source,
  base,
  onChange,
}: {
  source: SessionChangesSource;
  base: string;
  onChange(source: SessionChangesSource): void;
}) {
  return (
    <OpenSelect
      className="session-diff-source-select"
      ariaLabel={t('Changes source')}
      value={source}
      tooltip={base ? t('Compared with {{base}}', { base }) : undefined}
      options={SESSION_CHANGES_SOURCES.map((value) => ({
        value,
        label: sessionChangesSourceLabel(value),
        // The last turn stands apart from Git's sources.
        separatorBefore: value === 'branch',
      }))}
      onChange={(value) => onChange(value as SessionChangesSource)}
    />
  );
}

/** Row 1 is the shared dock header with the surface's one tab strip (like the
 *  browser, terminal and file panes); row 2 is the toolbar row holding the
 *  Changes source (Git roots), the scope pill (count + totals) and the
 *  refresh control. */
function SessionDiffHeader({
  tabStrip,
  source,
  scope,
  actions,
  onClose,
  refreshDisabled,
  onRefresh,
}: {
  tabStrip: ReactNode;
  source: ReactNode;
  scope: ReactNode;
  actions: DockAction[];
  onClose?(): void;
  refreshDisabled: boolean;
  onRefresh(): void;
}) {
  return (
    <>
      <DockHeaderRow
        className="session-diff-header"
        ariaLabel={t('Changes')}
        onClose={onClose}
        left={tabStrip}
        actions={actions}
      />
      <div className="browser-pane-toolbar session-diff-toolbar">
        {source}
        {scope}
        <button
          type="button"
          className="browser-pane-nav-button session-diff-refresh"
          aria-label={t('Refresh')}
          data-tooltip={t('Refresh')}
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

/** A pane without a diff to list shows only its state under the header;
 *  null once there is a diff to list. */
function sessionDiffStatus(
  sessionId: string,
  { loading, ready, unsupported, error }: { loading: boolean; ready: boolean; unsupported: boolean; error: string },
  onRetry: () => void
): ReactNode {
  if (!sessionId) return <p className="utility-dock-empty">{t('Open a session to view its diff.')}</p>;
  if (loading && !ready) return <InitialSurface />;
  if (error) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (unsupported) return <p className="utility-dock-empty">{t('Session diff is unavailable.')}</p>;
  return null;
}

type SessionDiffPaneProps = {
  sessionId: string;
  active: boolean;
  /** The session's project folder: transcript paths under it become relative. */
  cwd?: string;
  /** Closes the host dock; the close button is absent without it. */
  onClose?(): void;
  /** Opens a changed file (a project-relative or absolute path) as a tab of this side panel. */
  onOpenFile?(path: string): void;
  /** The panel's open file tabs, drawn next to the Changes tab. */
  fileTabs?: SessionDiffFileTabs;
  /** The host mounts `DiffHeaderControls` itself: hide the in-pane header. */
  headerControlsExternal?: boolean;
  /** The host's Unified/Split + filter state (the pane keeps its own otherwise). */
  viewState?: DiffViewState;
};

export function SessionDiffPane({
  sessionId,
  active,
  fileTabs,
  headerControlsExternal,
  viewState,
  onClose,
  cwd,
  onOpenFile: openPath,
}: SessionDiffPaneProps) {
  const ownViewState = useDiffViewState(SESSION_DIFF_STYLE_KEY);
  const { viewMode, onViewModeChange, splitAvailable } = viewState ?? ownViewState;
  const {
    revision,
    busy,
    ready,
    unsupported,
    truncated,
    diffTooLarge,
    loading,
    error,
    refresh,
    adoptions,
    rows,
    repository,
    source,
    setSource,
    base,
    root,
  } = useSessionDiffRows(sessionId, active, cwd);
  // Git rows are repository-root-relative; the host opens project paths.
  const onOpenFile = useMemo(
    () =>
      openPath && repository && root ? (path: string) => openPath(gitRowOpenPath(root, cwd ?? '', path)) : openPath,
    [openPath, repository, root, cwd]
  );

  // Every changed file is one section of a single scroll; the island's files
  // segment scrolls to the top and a turn card's file to that file's section.
  const [revertError, setRevertError] = useState('');
  const [fileNotice, setFileNotice] = useState('');
  // A capped set draws one file: the one picked by its header (default: first).
  const [selectedPath, setSelectedPath] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The (session, source, folder) whose list was already drawn: later reads of
  // it never hold the list back again.
  const listDrawnFor = useRef('');
  const { collapsed, toggleCollapsed, expandPath, resetCollapsed, collapseActions } = useSessionDiffCollapse(rows);
  const tabs = useSessionDiffTabs({
    sessionId,
    active,
    bodyRef,
    fileTabs,
    onClose,
    onSessionChange: () => {
      setRevertError('');
      setFileNotice('');
      setSelectedPath('');
      resetCollapsed();
    },
    onReopen: () => setFileNotice(''),
  });
  const fileRequest = useSessionDiffRequests({
    sessionId,
    active,
    rows,
    ready,
    error,
    refresh,
    adoptions,
    setFileNotice,
    expandPath,
    showAllFiles: tabs.showAllFiles,
    openDiffTab: tabs.openDiffTab,
    setChangesOpen: tabs.setChangesOpen,
  });
  const { canRevertPath, revertFile } = useSessionDiffRevert({
    sessionId,
    active,
    busy,
    revision,
    refresh,
    setRevertError,
  });

  // The ONE header row renders in every state (no session, loading, error,
  // unsupported, empty, files) so close/expand are always reachable.
  const showCount = Boolean(sessionId) && !error && !unsupported && ready;
  const { focusRow, tabRows, awaitingFile, showChanges, pendingPath, visibleRows } = sessionDiffTabView({
    rows,
    diffTabs: tabs.diffTabs,
    focusPath: tabs.focusPath,
    changesOpen: tabs.changesOpen,
    fileRequest,
    otherSurfaceTabs: tabs.otherSurfaceTabs,
  });
  // Git rows list counts only; the files drawn open read their own patch —
  // one over the render limit only once the user asks to see it anyway.
  const selectedRow = focusRow ?? visibleRows.find((row) => row.path === selectedPath) ?? visibleRows[0] ?? null;
  const { withPatch, capped } = useSessionChangePatches({
    cwd,
    sessionId,
    rows: visibleRows,
    selectedId: selectedRow?.id ?? '',
  });
  // Capped: every file but the selected one lists its header only.
  const shownCollapsed = useMemo(
    () =>
      capped
        ? new Set([...collapsed, ...visibleRows.filter((row) => row !== selectedRow).map((row) => row.path)])
        : collapsed,
    [capped, collapsed, visibleRows, selectedRow]
  );
  // Capped: a header selects its file (unfolded); the selected one folds as usual.
  const onToggleFile = (path: string) => {
    if (!capped || path === selectedRow?.path) {
      toggleCollapsed(path);
      return;
    }
    setSelectedPath(path);
    expandPath(path);
  };
  const tabStrip = (
    <SessionDiffTabStrip
      pendingPath={pendingPath}
      showChanges={showChanges}
      focusRow={focusRow}
      tabRows={tabRows}
      fileTabs={fileTabs}
      onShowAllFiles={tabs.showAllFiles}
      onCloseChanges={tabs.closeChanges}
      onOpenDiffTab={tabs.openDiffTab}
      onCloseDiffTab={tabs.closeDiffTab}
    />
  );
  const scope = (
    <SessionDiffScope
      pendingPath={pendingPath}
      focusRow={focusRow}
      rows={rows}
      showCount={showCount}
      onOpenFile={onOpenFile}
      canRevertPath={canRevertPath}
      onRevert={revertFile}
    />
  );
  const header = !headerControlsExternal && (
    <SessionDiffHeader
      tabStrip={tabStrip}
      source={repository && <SessionChangesSourceSelect source={source} base={base} onChange={setSource} />}
      scope={scope}
      actions={[...diffModeActions(viewMode, onViewModeChange, splitAvailable), ...collapseActions]}
      onClose={onClose}
      refreshDisabled={!sessionId || loading}
      onRefresh={() => void refresh(true)}
    />
  );

  const status = sessionDiffStatus(sessionId, { loading, ready, unsupported, error }, () => void refresh(true));
  if (status) {
    return (
      <SessionDiffFrame>
        {header}
        {status}
      </SessionDiffFrame>
    );
  }
  let body: ReactNode;
  if (awaitingFile) body = <InitialSurface />;
  else if (rows.length === 0) {
    body = (
      <p className="utility-dock-empty">
        {repository ? sessionChangesEmptyText(source) : t('No changes from this session.')}
      </p>
    );
  } else {
    const drawnRows = visibleRows.map(withPatch);
    const drawnFocus = focusRow && withPatch(focusRow);
    // The list is first drawn once the unfolded files have their diffs: a
    // section that grows from "Loading diff…" to the whole diff pushes every
    // header below it out of view (a layout shift of the entire list).
    const listKey = `${sessionId}\0${source}\0${cwd ?? ''}`;
    const awaitingPatches =
      listDrawnFor.current !== listKey &&
      drawnRows.some((row) => sessionDiffBodyPending(row, row !== drawnFocus && shownCollapsed.has(row.path)));
    if (awaitingPatches) body = <InitialSurface />;
    else {
      listDrawnFor.current = listKey;
      body = (
        <SessionDiffStack
          stackRef={bodyRef}
          rows={drawnRows}
          focusRow={drawnFocus}
          mode={viewMode}
          collapsed={shownCollapsed}
          onToggle={onToggleFile}
          canRevertPath={canRevertPath}
          onRevert={revertFile}
          onOpenFile={onOpenFile}
        />
      );
    }
  }
  return (
    <SessionDiffFrame>
      {header}
      {truncated && <p className="session-diff-notice">{t('The session diff was truncated.')}</p>}
      {diffTooLarge && (
        <p className="session-diff-notice">{t('The diff is too large to show; file counts are still listed.')}</p>
      )}
      {revertError && <p className="session-diff-notice">{revertError}</p>}
      {fileNotice && (
        <p className="session-diff-notice" role="status">
          {fileNotice}
        </p>
      )}
      {body}{' '}
    </SessionDiffFrame>
  );
}
