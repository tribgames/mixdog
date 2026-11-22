import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SESSION_DIFF_STYLE_KEY } from './desktop-types';
import { diffModeActions, useDiffViewState, type DiffViewState } from './diff-header-controls';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { OpenSelect } from './OpenSelect';
import {
  SESSION_CHANGES_SOURCES,
  sessionChangesEmptyText,
  sessionChangesSourceLabel,
  publishPaneSelection,
  resolveSelectedRow,
  useSessionChangePatches,
  useSessionChangesSource,
  type SessionChangesSource,
} from './session-changes-store';
import { SessionDiffFrame, SessionDiffHeader, sessionDiffStatus } from './session-diff-chrome';
import { closeSessionDiffTurn, useSessionDiffTurnLifetime, useSessionDiffTurnTarget } from './session-diff-focus';
import { gitRowOpenPath, type SessionDiffRow } from './session-diff-model';
import { SessionDiffScope } from './session-diff-scope';
import { SessionDiffStack } from './session-diff-section';
import { SessionDiffTabStrip } from './session-diff-tab-strip';
import { SessionDiffTurnView } from './SessionDiffTurnView';
import { fileHeaderToggle, useSessionDiffCollapse } from './use-session-diff-collapse';
import { useSessionDiffRequests } from './use-session-diff-requests';
import { useSessionDiffRevert } from './use-session-diff-revert';
import { useSessionDiffRows } from './use-session-diff-rows';
import { sessionDiffTabView, useSessionDiffTabs, type SessionDiffFileTabs } from './use-session-diff-tabs';
import { emptyStateHost } from './empty-state-host';

const NO_ROWS: readonly SessionDiffRow[] = [];

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
  /** The pane (dock) this view lives in: while mounted, its capped-set pick
   *  is published under this key for the entries that open it. */
  paneKey?: string;
};

/** The session's changes: its Changes source, or one turn's own changes while
 *  a turn's target stands (a turn changes card, a tool call's diff link). The
 *  two views hold separate state; the source's stays as it was behind a turn. */
export function SessionDiffPane(props: SessionDiffPaneProps) {
  const { sessionId, active } = props;
  const ownViewState = useDiffViewState(SESSION_DIFF_STYLE_KEY);
  const viewState = props.viewState ?? ownViewState;
  const turn = useSessionDiffTurnTarget(active ? sessionId : '');
  const source = useSessionChangesSource();
  useSessionDiffTurnLifetime(sessionId, active);
  // Picking another source asks for that source: it ends the turn too.
  const shownSource = useRef(source);
  useEffect(() => {
    if (shownSource.current === source) return;
    shownSource.current = source;
    closeSessionDiffTurn(sessionId);
  }, [sessionId, source]);
  return (
    <>
      <SessionDiffSource {...props} viewState={viewState} covered={turn !== null} />
      {turn && (
        <SessionDiffTurnView
          key={turn.checkpointId}
          target={turn}
          cwd={props.cwd}
          fileTabs={props.fileTabs}
          headerControlsExternal={props.headerControlsExternal}
          viewState={viewState}
          onClose={props.onClose}
          onOpenFile={props.onOpenFile}
        />
      )}
    </>
  );
}

function SessionDiffSource({
  sessionId,
  active,
  paneKey,
  fileTabs,
  headerControlsExternal,
  viewState,
  covered,
  onClose,
  cwd,
  onOpenFile: openPath,
}: SessionDiffPaneProps & {
  viewState: DiffViewState;
  /** A turn's view stands in front: this one keeps its tabs, picks and folds, reads nothing and draws nothing. */
  covered: boolean;
}) {
  const { viewMode, onViewModeChange, splitAvailable } = viewState;
  const reading = active && !covered;
  const {
    turnReviewKey,
    busy,
    ready,
    unsupported,
    loading,
    error,
    refresh,
    adoptions,
    rows,
    diff,
    repository,
    source,
    setSource,
    base,
    root,
    untrackedOmitted,
  } = useSessionDiffRows(sessionId, reading, cwd);
  // Git rows are repository-root-relative; the host opens project paths.
  const onOpenFile = useMemo(
    () =>
      openPath && repository && root ? (path: string) => openPath(gitRowOpenPath(root, cwd ?? '', path)) : openPath,
    [openPath, repository, root, cwd]
  );

  // Every changed file is one section of a single scroll; the island's files
  // segment scrolls to the top and a turn card's file to that file's section.
  const [revertError, setRevertError] = useState('');
  // A capped set draws one file: the one picked by its header (default: first).
  const [selectedPath, setSelectedPath] = useState('');
  // The pick is the pane's own; the intents that open this pane only read a copy.
  useEffect(
    () => (paneKey ? publishPaneSelection(paneKey, sessionId, selectedPath) : undefined),
    [paneKey, sessionId, selectedPath]
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { isFolded, toggleCollapsed, expandRow, resetCollapsed, collapseActions } = useSessionDiffCollapse(rows);
  const tabs = useSessionDiffTabs({
    sessionId,
    active,
    bodyRef,
    fileTabs,
    onClose,
    onSessionChange: () => {
      setRevertError('');
      setSelectedPath('');
      resetCollapsed();
    },
  });
  const fileRequest = useSessionDiffRequests({
    sessionId,
    active,
    rows,
    ready,
    error,
    refresh,
    adoptions,
    expandRow,
    showAllFiles: tabs.showAllFiles,
    openDiffTab: tabs.openDiffTab,
    setChangesOpen: tabs.setChangesOpen,
  });
  const { canRevertPath, revertFile } = useSessionDiffRevert({
    sessionId,
    active: reading,
    busy,
    reviewKey: turnReviewKey,
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
  // A turn's view opens over the source's list: that is what leaving it shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per turn view; the tab action is read at that moment
  useLayoutEffect(() => {
    if (covered) tabs.showAllFiles();
  }, [covered]);
  // Git rows list counts only; the files drawn open read their own patch —
  // one over the render limit only once the user asks to see it anyway.
  const selectedRow = resolveSelectedRow(visibleRows, focusRow, selectedPath);
  const { withPatch, capped } = useSessionChangePatches({
    cwd,
    sessionId,
    diff,
    rows: covered ? NO_ROWS : visibleRows,
    selectedId: selectedRow?.id ?? '',
  });
  if (covered) return null;
  const onToggleFile = fileHeaderToggle({
    capped,
    rows: visibleRows,
    selectedRow,
    toggleCollapsed,
    expandRow,
    select: setSelectedPath,
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
      unlistedCount={untrackedOmitted}
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
      <p className="utility-dock-empty mx-empty-state" ref={emptyStateHost}>
        {repository ? sessionChangesEmptyText(source) : t('No changes from this session.')}
      </p>
    );
  } else {
    // The list draws at once: a file whose patch is still being read shows
    // its header with "Loading diff…" until the patch lands.
    body = (
      <SessionDiffStack
        stackRef={bodyRef}
        rows={visibleRows}
        withPatch={withPatch}
        focusRow={focusRow}
        mode={viewMode}
        isFolded={isFolded}
        // Capped: every file but the selected one lists its header only.
        selectedRow={capped ? selectedRow : undefined}
        onToggle={onToggleFile}
        canRevertPath={canRevertPath}
        onRevert={revertFile}
        onOpenFile={onOpenFile}
      />
    );
  }
  return (
    <SessionDiffFrame>
      {header}
      {revertError && <p className="session-diff-notice">{revertError}</p>}
      {body}{' '}
    </SessionDiffFrame>
  );
}
