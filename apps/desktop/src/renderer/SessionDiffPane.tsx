import { RefreshCw } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SESSION_DIFF_STYLE_KEY } from './desktop-types';
import { diffModeActions, useDiffViewState, type DiffViewState } from './diff-header-controls';
import { DockHeaderRow, type DockAction } from './pane-dock-chrome';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import type { SessionDiffResult } from './session-diff-model';
import { SessionDiffScope } from './session-diff-scope';
import { SessionDiffStack } from './session-diff-section';
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

/** Row 1 is the shared dock header with the surface's one tab strip (like the
 *  browser, terminal and file panes); row 2 is the toolbar row holding the
 *  scope pill (count + totals) and the refresh control. */
function SessionDiffHeader({
  tabStrip,
  scope,
  actions,
  onClose,
  refreshDisabled,
  onRefresh,
}: {
  tabStrip: ReactNode;
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
  { loading, result, error }: { loading: boolean; result: SessionDiffResult | null; error: string },
  onRetry: () => void
): ReactNode {
  if (!sessionId) return <p className="utility-dock-empty">{t('Open a session to view its diff.')}</p>;
  if (loading && !result) return <InitialSurface />;
  if (error) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (result?.supported === false) return <p className="utility-dock-empty">{t('Session diff is unavailable.')}</p>;
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
  onOpenFile,
  fileTabs,
  headerControlsExternal,
  viewState,
  onClose,
  cwd,
}: SessionDiffPaneProps) {
  const ownViewState = useDiffViewState(SESSION_DIFF_STYLE_KEY);
  const { viewMode, onViewModeChange, splitAvailable } = viewState ?? ownViewState;
  const { revision, busy, result, loading, error, refresh, adoptions, rows } = useSessionDiffRows(
    sessionId,
    active,
    cwd
  );

  // Every changed file is one section of a single scroll; the island's files
  // segment scrolls to the top and a turn card's file to that file's section.
  const [revertError, setRevertError] = useState('');
  const [fileNotice, setFileNotice] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
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
      resetCollapsed();
    },
    onReopen: () => setFileNotice(''),
  });
  const fileRequest = useSessionDiffRequests({
    sessionId,
    active,
    rows,
    result,
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
  const showCount = Boolean(sessionId) && !error && result?.supported !== false && Boolean(result);
  const { focusRow, tabRows, awaitingFile, showChanges, pendingPath, visibleRows } = sessionDiffTabView({
    rows,
    diffTabs: tabs.diffTabs,
    focusPath: tabs.focusPath,
    changesOpen: tabs.changesOpen,
    fileRequest,
    otherSurfaceTabs: tabs.otherSurfaceTabs,
  });
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
      scope={scope}
      actions={[...diffModeActions(viewMode, onViewModeChange, splitAvailable), ...collapseActions]}
      onClose={onClose}
      refreshDisabled={!sessionId || loading}
      onRefresh={() => void refresh(true)}
    />
  );

  const status = sessionDiffStatus(sessionId, { loading, result, error }, () => void refresh(true));
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
  else if (rows.length === 0) body = <p className="utility-dock-empty">{t('No changes from this session.')}</p>;
  else {
    body = (
      <SessionDiffStack
        stackRef={bodyRef}
        rows={visibleRows}
        focusRow={focusRow}
        mode={viewMode}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        canRevertPath={canRevertPath}
        onRevert={revertFile}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <SessionDiffFrame>
      {header}
      {result?.patchTruncated && <p className="session-diff-notice">{t('The session diff was truncated.')}</p>}
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
