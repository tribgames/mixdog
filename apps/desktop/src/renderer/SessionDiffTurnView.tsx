import { ArrowLeft } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { diffModeActions, type DiffViewState } from './diff-header-controls';
import { emptyStateHost } from './empty-state-host';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { resolveSelectedRow } from './session-changes-store';
import { SessionDiffFrame, SessionDiffHeader, sessionDiffStatus } from './session-diff-chrome';
import { closeSessionDiffTurn, type SessionDiffTurnTarget } from './session-diff-focus';
import { gitRowOpenPath, isAbsolutePath } from './session-diff-model';
import { SessionDiffScope } from './session-diff-scope';
import { SessionDiffStack } from './session-diff-section';
import { SessionDiffTabStrip } from './session-diff-tab-strip';
import { normalizeChangePath } from './turn-changes-model';
import { fileHeaderToggle, useSessionDiffCollapse } from './use-session-diff-collapse';
import type { SessionDiffFileTabs } from './use-session-diff-tabs';
import { useSessionDiffTurn } from './use-session-diff-turn';

/** A file the view was opened on, as it was asked for: the record's own path,
 *  or a tool call's path with that call's folder (`cwd`; '' = the session's). */
type Asked = { path: string; cwd?: string };

/** The turn view's own tab strip: its list ("Changes") and the files opened
 *  in it; `focus` is the selected file (null = the list). A file has its tab
 *  from the moment it is asked for, whatever the record answers of it. */
type TurnTabs = { files: readonly Asked[]; focus: Asked | null; listOpen: boolean };

const NO_TABS: TurnTabs = { files: [], focus: null, listOpen: true };
const ownPatch = <Row,>(row: Row) => row;
const cannotRevert = () => false;
const noRevert = () => undefined;
const sameAsked = (a: Asked, b: Asked) => a.path === b.path && a.cwd === b.cwd;

/** What an open of the turn asks for: its file, or null for the list. */
function askedOf(target: SessionDiffTurnTarget): Asked | null {
  const path = normalizeChangePath(target.path);
  if (!path) return null;
  return target.cwd === undefined ? { path } : { path, cwd: target.cwd };
}

/** The file an asked path names, as the record is asked for it: the record's
 *  own path, or a tool call's path under that call's folder. A call that
 *  names no folder ran in the session's: null until that folder is known,
 *  since the record's root is another folder. */
function askedFile(asked: Asked, sessionCwd: string | undefined): string | null {
  if (asked.cwd === undefined || isAbsolutePath(asked.path)) return asked.path;
  const folder = asked.cwd || sessionCwd;
  // A root folder ("/", "C:/") is a known folder too.
  return folder ? `${normalizeChangePath(folder).replace(/\/+$/, '')}/${asked.path}` : null;
}

function withOpened(tabs: TurnTabs, asked: Asked | null): TurnTabs {
  if (!asked) return { ...tabs, focus: null, listOpen: true };
  const held = tabs.files.find((file) => sameAsked(file, asked));
  return { ...tabs, files: held ? tabs.files : [...tabs.files, asked], focus: held ?? asked };
}

/** In place of the source picker; Back returns to the selected source. */
function TurnScopeLabel({ onBack }: { onBack(): void }) {
  return (
    <span className="session-diff-turn-scope">
      <button
        type="button"
        className="browser-pane-nav-button"
        aria-label={t('Back')}
        data-tooltip={t('Back')}
        onClick={onBack}
      >
        <ArrowLeft size={15} aria-hidden="true" />
      </button>
      <span className="session-diff-turn-label">{t('Turn changes')}</span>
    </span>
  );
}

/** One turn's own changes in the session diff pane (a turn changes card's
 *  View changes or file row, a tool call's diff link). Mounted per turn, it
 *  holds everything it shows: its tabs, its reads and its folds. Nothing of
 *  the pane's Changes source is read or changed here; leaving (Back, or
 *  closing its last tab) only ends the turn's target. Each tab shows its own
 *  file's state: another file's read, late or failed, changes nothing of it. */
export function SessionDiffTurnView({
  target,
  cwd,
  fileTabs,
  headerControlsExternal,
  viewState,
  onClose,
  onOpenFile: openPath,
}: {
  target: SessionDiffTurnTarget;
  /** The session's folder: a tool call's path is under it, opened files relative to it. */
  cwd?: string;
  fileTabs?: SessionDiffFileTabs;
  headerControlsExternal?: boolean;
  viewState: DiffViewState;
  onClose?(): void;
  onOpenFile?(path: string): void;
}) {
  const { sessionId, checkpointId, boundary } = target;
  const { viewMode, onViewModeChange, splitAvailable } = viewState;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Every open of the turn (a new `seq`) lands on its file or on the list.
  const [opens, setOpens] = useState(() => ({ seq: target.seq, tabs: withOpened(NO_TABS, askedOf(target)) }));
  let { tabs } = opens;
  if (opens.seq !== target.seq) {
    tabs = withOpened(tabs, askedOf(target));
    setOpens({ seq: target.seq, tabs });
  }
  const setTabs = (next: TurnTabs) => {
    setOpens({ seq: target.seq, tabs: next });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const leave = () => closeSessionDiffTurn(sessionId);

  // The focused file's patch is what is read; a file whose folder is not known yet waits unread.
  const turn = useSessionDiffTurn({
    sessionId,
    checkpointId,
    boundary,
    visualized: target.visualized,
    want: tabs.focus ? askedFile(tabs.focus, cwd) : '',
  });
  /** A file's tab: the record's row of it once the record lists it, and the path it is named by. */
  const tabOf = (asked: Asked) => {
    const file = askedFile(asked, cwd);
    const row = file === null ? null : turn.rowAt(file);
    const path = row?.path ?? file ?? asked.path;
    return { id: path, path, file, row };
  };
  // Two ways of asking for one file are one tab.
  const openTabs = [...new Map(tabs.files.map((asked) => [tabOf(asked).id, tabOf(asked)])).values()];
  const focus = tabs.focus ? tabOf(tabs.focus) : null;
  const focusRow = focus?.row ?? null;
  const visibleRows = focus ? (focusRow ? [focusRow] : []) : turn.rows;
  const closeTab = (id: string) => {
    const files = tabs.files.filter((asked) => tabOf(asked).id !== id);
    if (focus?.id !== id) setTabs({ ...tabs, files });
    else if (tabs.listOpen) setTabs({ ...tabs, files, focus: null });
    else if (files.length) setTabs({ ...tabs, files, focus: files.at(-1) as Asked });
    else leave();
  };
  // The view lasts while it has a tab.
  const closeList = () => {
    const last = tabs.files.at(-1);
    if (!last) leave();
    else setTabs({ ...tabs, listOpen: false, focus: tabs.focus ?? last });
  };
  const openTab = (id: string) => {
    const asked = tabs.files.find((file) => tabOf(file).id === id);
    if (asked) setTabs({ ...tabs, focus: asked });
  };

  const { isFolded, toggleCollapsed, expandRow, collapseActions } = useSessionDiffCollapse(turn.rows);
  // A capped set draws one file: the one picked by its header (default: first).
  const [selectedPath, setSelectedPath] = useState('');
  const selectedRow = resolveSelectedRow(visibleRows, focusRow, selectedPath);
  // The turn's rows are root-relative; the host opens project paths.
  const { root } = turn;
  const onOpenFile = useMemo(
    () =>
      openPath &&
      ((path: string) => openPath(root && !isAbsolutePath(path) ? gitRowOpenPath(root, cwd ?? '', path) : path)),
    [openPath, root, cwd]
  );

  const hasTabs = openTabs.length > 0 || (fileTabs?.tabs.length ?? 0) > 0;
  const header = !headerControlsExternal && (
    <SessionDiffHeader
      tabStrip={
        hasTabs ? (
          <SessionDiffTabStrip
            pendingPath=""
            showChanges={tabs.listOpen}
            focusRow={focus}
            tabRows={openTabs}
            fileTabs={fileTabs}
            onShowAllFiles={() => setTabs(withOpened(tabs, null))}
            onCloseChanges={closeList}
            onOpenDiffTab={openTab}
            onCloseDiffTab={closeTab}
          />
        ) : null
      }
      source={<TurnScopeLabel onBack={leave} />}
      scope={
        <SessionDiffScope
          // A file the record has not answered of, or does not list, is named by its path alone.
          pendingPath={focus && !focusRow ? focus.path : ''}
          focusRow={focusRow}
          rows={turn.rows}
          unlistedCount={0}
          showCount={turn.answered}
          onOpenFile={onOpenFile}
          canRevertPath={cannotRevert}
          onRevert={noRevert}
        />
      }
      actions={[...diffModeActions(viewMode, onViewModeChange, splitAvailable), ...collapseActions]}
      onClose={onClose}
      refreshDisabled={turn.loading}
      onRefresh={turn.refresh}
    />
  );
  const note = (text: string) => (
    <p className="utility-dock-empty mx-empty-state" ref={emptyStateHost}>
      {text}
    </p>
  );
  // The record's list first: unread, still being recorded, or failed. Then the selected tab's own state.
  let body: ReactNode = sessionDiffStatus(
    sessionId,
    {
      loading: !turn.answered && !turn.recording && !turn.listError,
      ready: turn.answered,
      unsupported: false,
      error: turn.listError,
    },
    turn.refresh
  );
  if (!body && turn.recording) body = note(t("This turn's changes are still being recorded."));
  else if (!body && focus && focus.file === null) body = <InitialSurface />;
  // A file the record does not list has no diff of this turn, however it was asked for; a list still being read
  // again (a newer end may list it) has not said so yet.
  else if (!body && focus && !focusRow) {
    body = turn.fresh ? note(t('No diff was recorded for this file.')) : <InitialSurface />;
  } else if (!body && turn.patchError) body = <ErrorNotice error={turn.patchError} onRetry={turn.refresh} />;
  else if (!body && visibleRows.length === 0) body = note(t('No changes'));
  body ??= (
    <SessionDiffStack
      stackRef={bodyRef}
      rows={visibleRows}
      // A turn's rows carry their own patch.
      withPatch={ownPatch}
      focusRow={focusRow}
      mode={viewMode}
      isFolded={isFolded}
      // Capped: every file but the selected one lists its header only.
      selectedRow={turn.capped ? selectedRow : undefined}
      onToggle={fileHeaderToggle({
        capped: turn.capped,
        rows: visibleRows,
        selectedRow,
        toggleCollapsed,
        expandRow,
        select: setSelectedPath,
      })}
      canRevertPath={cannotRevert}
      onRevert={noRevert}
      onOpenFile={onOpenFile}
    />
  );
  return (
    <SessionDiffFrame>
      {header}
      {body}
    </SessionDiffFrame>
  );
}
