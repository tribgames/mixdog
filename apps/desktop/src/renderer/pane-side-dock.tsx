import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FolderTree } from 'lucide-react';
import type { SideFileChrome } from './side-surface-strip';
import { DockHeaderRow, PaneDockExpandContext } from './pane-dock-chrome';
import { useDockPanelActions } from './dock-panel-actions';
import { PaneDockDiffColumn } from './pane-dock-diff-column';
import { PaneDockFileSurface } from './PaneDockFileSurface';
import { SESSION_BOUND_VIEWS } from './pane-dock-toggles';
import { useVisualizeAvailable } from './visualize-store';
import { publishPhoneDockSwitch, type PhoneDockSwitchItem } from './phone-dock-switch';
import {
  clampPaneDockHeight,
  commitWidthPref,
  PANE_SIDE_DOCK_DEFAULT_HEIGHT,
  PANE_SIDE_DOCK_HEIGHT_KEY,
  PANE_SIDE_DOCK_MIN_HEIGHT,
  paneDockResizeAxis,
  useDiffColumnResize,
  useDockCellWidth,
  useDockCloseRequest,
  useDockExpansion,
  useDockHeightDrag,
  useDockMounting,
  useDockRoomHeight,
  useInlineDockFlag,
  usePanelWidthDrag,
  useSessionPanelShown,
  useSheetExit,
  useSidePanelPlacement,
  useSideFileProblems,
} from './pane-side-dock-hooks';
import { PaneDockSurfaceSlot } from './pane-side-dock-surface-slot';
import { DeferredPersistentSurface } from './PaneSurfaceGate';
import {
  PANE_SIDE_DOCK_WIDTH_KEY,
  PANE_SIDE_DOCK_DEFAULT_WIDTH,
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_MAX_WIDTH,
  PANE_SIDE_DOCK_DIFF_WIDTH_KEY,
  PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH,
  PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  paneFilesShowing,
  paneFileShowing,
  paneDockActiveFile,
  paneDockOpenNow,
  paneDiffShowing,
  paneDockActiveRoot,
  paneDiffStacks,
  paneOverlayRoom,
  paneSidePresentation,
  paneSideRoom,
  readStoredWidth,
  readSharedDockWidth,
  type PaneSideDockDiff,
  type PaneSideDockFolder,
  type PaneSideDockEntry,
} from './pane-side-dock-model';

import { DIFF_STARTUP_DELAY_MS, ReadyGitDiffPane } from './app-shell-components';
import { FileText as FileIcon } from 'lucide-react';
import { DiffHeaderControls, diffScopeLabel, useDiffViewState } from './diff-header-controls';
import { DesktopLoadingSurface } from './RendererRecovery';
import { useMobileRemoteSurface } from './mobile-surface';
import {
  WorkbenchSidePanel,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewGroup,
  type WorkbenchSideViewId,
  type WorkbenchSideViewPlacement,
} from './workbench-side-view-layout';
import { t } from './i18n';
import { syncTranscriptWidths } from './transcript-list-resize-patch';
import { sideFileKey, type PaneSideDockFile } from './side-file-tabs';
import { SessionRailCard } from './SessionRailCard';
import { useSessionDiffStripHasTabs } from './use-session-diff-tabs';
import { clampSessionRailWidth, type SessionRailFit, sessionRailFit, useSessionRailWidth } from './session-rail-layout';

export {
  PANE_SIDE_DOCK_DEFAULT_WIDTH,
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_MAX_WIDTH,
  PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH,
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  PANE_DOCK_FILE_SURFACE,
  PANE_DOCK_FILES_SURFACE,
  paneFilesShowing,
  paneDockActiveFile,
  paneDockOpenNow,
  paneDockOwnerOf,
  paneDiffShowing,
  paneDockActiveRoot,
  paneDiffStacks,
  normalizePaneSideDocks,
  samePaneSideDocks,
  paneDockRestored,
  paneLocalSurface,
  paneDockForeign,
  withPaneLocalOwner,
  reconcilePaneDockOwners,
  withPaneDockFileOpened,
  withPaneDockFileKept,
  withPaneDockFileClosed,
  paneDockFileCloseEndsDock,
  withPaneDockFolderOpened,
  withPaneDockFolderClosed,
  withPaneDockDiffOpened,
  withPaneDockDiffClosed,
  readStoredWidth,
  readSharedDockWidth,
} from './pane-side-dock-model';
export type { PaneSideDockDiff, PaneSideDockFolder, PaneSideDockEntry } from './pane-side-dock-model';
export type { PaneSideDockFile };

const PANE_DOCK_DIFF_RETAIN_MS = 1_500;
export function useRetainedDiff(diff: PaneSideDockDiff | null): PaneSideDockDiff | null {
  const [retained, setRetained] = useState<PaneSideDockDiff | null>(diff);
  useEffect(() => {
    if (diff) {
      setRetained(diff);
      return undefined;
    }
    let lastInputAt = performance.now();
    const noteInput = () => {
      lastInputAt = performance.now();
    };
    document.addEventListener('keydown', noteInput, true);
    document.addEventListener('input', noteInput, true);
    let timer = 0;
    const stopListening = () => {
      document.removeEventListener('keydown', noteInput, true);
      document.removeEventListener('input', noteInput, true);
    };
    const attempt = () => {
      const quietFor = performance.now() - lastInputAt;
      if (quietFor < PANE_DOCK_DIFF_RETAIN_MS) {
        timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS - quietFor);
        return;
      }
      timer = 0;
      // The tree is dropped: nothing is left to protect from a keystroke, so
      // the document-level capture listeners must not outlive this decision.
      stopListening();
      startTransition(() => setRetained(null));
    };
    timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS);
    return () => {
      stopListening();
      window.clearTimeout(timer);
    };
  }, [diff]);
  return retained;
}

function useDockWidthPrefs() {
  const [dockPref, setDockPref] = useState(readSharedDockWidth);
  const [diffPref, setDiffPref] = useState(() =>
    readStoredWidth(
      PANE_SIDE_DOCK_DIFF_WIDTH_KEY,
      PANE_SIDE_DOCK_MIN_WIDTH,
      PANE_SIDE_DOCK_MAX_WIDTH,
      PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH
    )
  );
  return { dockPref, setDockPref, diffPref, setDiffPref };
}

function resolveDockLayout({
  cellWidth,
  room,
  openNow,
  mobileSheet,
  diffShowing,
  sessionSurfaceShowing,
  sessionMin,
  sessionPref,
  panelPref,
  diffPref,
}: {
  cellWidth: number;
  room: number;
  openNow: boolean;
  mobileSheet: boolean;
  diffShowing: boolean;
  sessionSurfaceShowing: boolean;
  sessionMin: number;
  sessionPref: number;
  panelPref: number;
  diffPref: number;
}) {
  const panelDesired = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelPref, PANE_SIDE_DOCK_MAX_WIDTH));
  const diffDesired = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(diffPref, PANE_SIDE_DOCK_MAX_WIDTH));
  const pairMin = PANE_SIDE_DOCK_MIN_WIDTH * 2;
  const twoDepth = paneDiffStacks(diffShowing, paneOverlayRoom(cellWidth), pairMin, mobileSheet);
  const pairShowing = diffShowing && !twoDepth;
  let columnMin = PANE_SIDE_DOCK_MIN_WIDTH;
  if (sessionSurfaceShowing) columnMin = sessionMin;
  else if (pairShowing) columnMin = pairMin;
  // Overlay decision: the diff PAIR never shrinks inline — the moment panel+diff no longer fit beside the
  // conversation floor, the whole unit floats over the pane. View/browser
  // modes shrink toward their own minimum first.
  let inlineFloor = columnMin;
  if (pairShowing) inlineFloor = panelDesired + diffDesired;
  else if (sessionSurfaceShowing) inlineFloor = sessionMin;
  const ladder = paneSidePresentation({ cellWidth, room, columnMin, inlineFloor });
  const fullTakeover = openNow && ladder.presentation === 'full';
  const overlay = openNow && ladder.presentation !== 'beside';
  const avail = openNow ? ladder.avail : room;
  let asideTarget = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelPref, avail));
  if (fullTakeover) asideTarget = cellWidth;
  else if (sessionSurfaceShowing) {
    asideTarget = Math.max(sessionMin, Math.min(sessionPref, avail));
  } else if (pairShowing) {
    asideTarget = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelDesired, avail - PANE_SIDE_DOCK_MIN_WIDTH));
  }
  const baseAsideWidth = Math.round(asideTarget);
  const diffWidth = pairShowing
    ? Math.round(Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(diffDesired, avail - baseAsideWidth)))
    : 0;
  return { diffDesired, twoDepth, pairShowing, overlay, baseAsideWidth, diffWidth };
}

type DockLayoutInput = Omit<Parameters<typeof resolveDockLayout>[0], 'room' | 'cellWidth'>;

/** The dock and the session panel decided together, from the pane cell's
 *  width: the dock as it lays out alone (resolveDockLayout), and the panel
 *  on the same ladder in the whole cell, with what the conversation gives up
 *  for it (sessionRailFit). A dock open at the pane's side, inline, floating
 *  or expanded, covers the panel: it is not shown (width 0), and the composer
 *  keeps its island and controls until the dock closes. A dock below the
 *  conversation covers nothing. Before the first measure (a render that is
 *  never painted: useDockCellWidth measures before paint) the panel has its
 *  preferred width, beside. */
export function paneDockRailLayout({
  cellWidth,
  bottom,
  sheetFrame,
  rail,
  dock,
}: {
  cellWidth: number;
  bottom: boolean;
  sheetFrame: number;
  /** The panel's width preference; null while it is off. */
  rail: number | null;
  dock: DockLayoutInput;
}) {
  const roomFor = (cell: number) => (bottom && cell > 0 ? cell - 2 : paneSideRoom(cell, sheetFrame));
  const alone = resolveDockLayout({ ...dock, cellWidth, room: roomFor(cellWidth) });
  if (rail === null || (dock.openNow && !bottom)) return { dock: alone, rail: SESSION_RAIL_OFF };
  if (cellWidth <= 0) {
    return { dock: alone, rail: { width: clampSessionRailWidth(rail), reserve: 0, presentation: 'beside' as const } };
  }
  return { dock: alone, rail: sessionRailFit({ cellWidth, railPref: rail }) };
}

const SESSION_RAIL_OFF: SessionRailFit = { width: 0, reserve: 0, presentation: 'beside' };

/** The desktop header row for the diff and the panel views. */
function PaneDockChromeRow({
  diffShowing,
  diff,
  diffView,
  panelTitle,
  titleHidden,
  leafId,
  renderDiffHeaderControls,
  onClose,
}: {
  diffShowing: boolean;
  diff: PaneSideDockDiff | null;
  diffView: ReturnType<typeof useDiffViewState>;
  panelTitle: string;
  /** The panel body names itself (the agent panel's own tabs): the row keeps
   *  its controls (⋯ switch, ×) and drops the repeated title. */
  titleHidden: boolean;
  leafId: string;
  renderDiffHeaderControls?: () => ReactNode;
  onClose(): void;
}) {
  const panelActions = useDockPanelActions(leafId);
  return (
    <DockHeaderRow
      className="pane-side-dock-chrome"
      actions={diffShowing ? undefined : panelActions}
      ariaLabel={diffShowing ? t('Changes') : titleHidden ? panelTitle : undefined}
      left={
        diffShowing && diff ? (
          <>
            <div className="browser-tab is-active dock-header-chip">
              <span className="browser-tab-select" title={`${diff.rel}\n${diffScopeLabel(diff.source)}`}>
                <FileIcon size={14} aria-hidden="true" />
                <span>{diff.rel.split('/').at(-1) ?? diff.rel}</span>
              </span>
            </div>
            {renderDiffHeaderControls?.() ?? <DiffHeaderControls {...diffView} />}
          </>
        ) : titleHidden ? null : (
          <span className="dock-header-title">{panelTitle}</span>
        )
      }
      onClose={onClose}
    />
  );
}

/** Phone sheet: no title/icon bar of its own — each pane's PC header row is the
 *  top row, and the pane switch (Changes / Browser / Terminal / …, plus the
 *  project Files tree) rides in that row's ⋯ menu through phone-dock-switch. */
function PhoneDockSwitchPublisher({
  groups,
  descriptors,
  activeRoot,
  sessionBound,
  files,
  keepVisualize,
  onSelect,
}: {
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  activeRoot: WorkbenchSideViewId | null;
  sessionBound: boolean;
  keepVisualize: boolean;
  files?: { active: boolean; onOpen(): void };
  onSelect(id: WorkbenchSideViewId): void;
}) {
  // Coding panes list Visualize once the agent has shown something; an agent
  // chat's own switch (`keepVisualize`) always does, as its header does.
  const visualizeAvailable = useVisualizeAvailable();
  const items: PhoneDockSwitchItem[] = [];
  if (files) items.push({ id: 'files', label: t('Files'), icon: FolderTree, active: files.active, disabled: false });
  for (const group of groups) {
    const root = group[0];
    const descriptor = root === undefined ? undefined : descriptors.get(root);
    if (!root || !descriptor) continue;
    if (root === 'visualize' && !keepVisualize && !visualizeAvailable) continue;
    // Only an Agents row opens the agent session view; the switch names it while it shows.
    if (root === 'agent-session' && activeRoot !== root) continue;
    items.push({
      id: root,
      label: descriptor.tooltip || descriptor.label,
      icon: descriptor.icon,
      active: activeRoot !== null && group.includes(activeRoot),
      disabled: !sessionBound && SESSION_BOUND_VIEWS.includes(root),
    });
  }
  useEffect(() => {
    publishPhoneDockSwitch(items, (id) => {
      if (id === 'files') files?.onOpen();
      else onSelect(id as WorkbenchSideViewId);
    });
  });
  useEffect(() => () => publishPhoneDockSwitch([], () => {}), []);
  return null;
}
type PaneSideDockProps = {
  leafId: string;
  entry: PaneSideDockEntry;
  /** A session stands behind the pane (its session-owned toggles are live). */
  sessionBound?: boolean;
  /** This tab's session has its Changes view open (its user opened it and has
   *  not folded the panel since): Changes leads the file tabs. */
  changesTab?: boolean;
  /** The session whose terminal this dock shows when it is not the dock's own
   *  (a child's terminal revealed in its owner's dock): that terminal's X
   *  names the child, so the dock answers to it too. */
  terminalSessionId?: string;
  /** Phone sheet header: shows the pane project's Files tree. Absent without
   *  a project, so no Files toggle is drawn. */
  onOpenFiles?(): void;
  /** Optional controls rendered in the diff header's left slot after the
   *  file chip (the unified/split menu by default). */
  renderDiffHeaderControls?: () => ReactNode;
  groups: readonly WorkbenchSideViewGroup[];
  /** The phone ⋯ pane switch's children when they differ from `groups` (an
   *  agent-mode chat leaves Changes out; its changes card opens the diff). */
  switchGroups?: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  focused: boolean;
  /** The session this pane shows; its browser/terminal X closes this dock. */
  sessionId?: string;
  /** The New Task draft this pane shows instead: its session panel shows as a session's does. */
  draftId?: string;
  /** Hidden-mount only the focused pane's panel shell after boot. */
  prewarm?: boolean;
  onSelect(id: WorkbenchSideViewId): void;
  /** Folds the unit — the header X, and a re-click on the active icon. */
  onClose(): void;
  onCloseDiff(): void;
  /** The header X while a side file shows: closes the file (confirming unsaved
   *  edits) and folds the unit. Absent, the X just folds. */
  onCloseFile?(): void;
  /** A file tab's own close (confirming that tab's unsaved edits). */
  onCloseFileTab?(fileKey: string): void;
  onActivateFile?(fileKey: string): void;
  /** "Keep open": the preview tab becomes a normal tab. */
  onKeepFile?(fileKey: string): void;
  /** The header X while the Files tree shows: drops the folder and folds the unit. */
  onCloseFolder?(): void;
  /** The project Files tree a transcript folder link revealed; draws its own
   *  DockHeaderRow in its slot. */
  renderFilesSurface?(folder: PaneSideDockFolder, active: boolean, side: { onClose: () => void }): ReactNode;
  onMoveGroup(
    sourceRoot: WorkbenchSideViewId,
    targetSide: 'left' | 'right',
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
  onMoveView(
    sourceId: WorkbenchSideViewId,
    targetSide: 'left' | 'right',
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
  onFocusPane(): void;
  /** A side file tab holds unsaved edits (`fileKey`: sideFileKey). */
  isFileDirty?(fileKey: string): boolean;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
  /** `exiting`: the dock closed, but its sheet's exit slide still carries the
   *  surface (useSheetExit) — it keeps its pixels and nothing else: inert,
   *  aria-hidden, unfocused and not foreground from the close commit. */
  renderBrowserSurface?(active: boolean, exiting: boolean): ReactNode;
  renderTerminalSurface?(active: boolean, exiting: boolean): ReactNode;
  /** `onSideChrome` receives the editor's dirty/problem/action state for the
   *  dock's file strip; the editor draws no breadcrumb row of its own. */
  renderFileSurface?(
    file: PaneSideDockFile,
    active: boolean,
    side: { onChrome: (chrome: SideFileChrome | null) => void; onShowProblems: () => void }
  ): ReactNode;
  /** The Problems body scoped to the side file; shown in a split under the
   *  editor, never in the main pane's bottom panel. */
  renderFileProblems?(file: PaneSideDockFile): ReactNode;
  renderView(id: WorkbenchSideViewId, active: boolean, titleDragProps: WorkbenchSideTitleDragProps): ReactNode;
};


/** Which child of an open unit is showing; every flag is false while folded. */
function paneDockShowing(entry: PaneSideDockEntry, openNow: boolean) {
  const surfaceShowing = openNow && entry.surface !== '';
  const browserShowing = surfaceShowing && entry.surface === PANE_DOCK_BROWSER_SURFACE;
  const terminalShowing = surfaceShowing && entry.surface === PANE_DOCK_TERMINAL_SURFACE;
  const fileShowing = surfaceShowing && paneFileShowing(entry);
  const filesShowing = surfaceShowing && paneFilesShowing(entry);
  const sessionSurfaceShowing = browserShowing || terminalShowing || fileShowing || filesShowing;
  const diffShowing = surfaceShowing && paneDiffShowing(entry);
  // The Changes, Visualize and agent session views draw their own DockHeaderRow.
  const sessionDiffPanelShowing =
    openNow &&
    entry.surface === '' &&
    (entry.view === 'session-diff' || entry.view === 'visualize' || entry.view === 'agent-session');
  // Width only: the visualize view is a page viewer and the agent session view
  // a conversation, so they size as a session surface (shrinking toward its
  // floor before the dock overlays).
  const widthSurfaceShowing =
    sessionSurfaceShowing ||
    (openNow && entry.surface === '' && (entry.view === 'visualize' || entry.view === 'agent-session'));
  return {
    browserShowing,
    terminalShowing,
    fileShowing,
    filesShowing,
    sessionSurfaceShowing,
    widthSurfaceShowing,
    diffShowing,
    sessionDiffPanelShowing,
  };
}

/** The panel column's drag range: the same for every surface. */
const PANE_SIDE_DOCK_WIDTH_RANGE = {
  min: PANE_SIDE_DOCK_MIN_WIDTH,
  max: PANE_SIDE_DOCK_MAX_WIDTH,
  initial: PANE_SIDE_DOCK_DEFAULT_WIDTH,
};

/** Expanded, the panel fills the sheet (minus its borders and the diff pair column). */
function expandedAsideWidth(
  baseAsideWidth: number,
  expandedRect: { width: number } | null | undefined,
  pairColumnWidth: number
): number {
  if (!expandedRect) return baseAsideWidth;
  return Math.max(baseAsideWidth, Math.round(expandedRect.width) - 2 - pairColumnWidth);
}

type DockDiffSurfaceContext = {
  diffShowing: boolean;
  diffView: ReturnType<typeof useDiffViewState>;
  openFileTab: PaneSideDockProps['openFileTab'];
  onCloseDiff(): void;
};

/** The same deferred diff body serves the stacked 2뎁스 layer and the pair column. */
function renderDockDiffSurface(selection: PaneSideDockDiff, context: DockDiffSurfaceContext, stacked = false) {
  return (
    <DeferredPersistentSurface
      active
      startupDelayMs={DIFF_STARTUP_DELAY_MS}
      fallback={<DesktopLoadingSurface label={t('Loading diff…')} />}
    >
      <ReadyGitDiffPane
        selection={selection}
        active={context.diffShowing}
        onOpenFile={context.openFileTab}
        chrome="side"
        onBack={stacked ? context.onCloseDiff : undefined}
        // The shared chrome row (chip, controls, ⋯ switch, ×) serves the phone too.
        headerControlsExternal
        viewState={context.diffView}
      />
    </DeferredPersistentSurface>
  );
}

/** The stacked children over the panel body — Files tree, file card, browser,
 *  terminal, and the 2뎁스 diff; falsy when none is mounted. */
function renderPaneDockSurfaces(
  props: Pick<
    PaneSideDockProps,
    | 'leafId'
    | 'entry'
    | 'focused'
    | 'onFocusPane'
    | 'isFileDirty'
    | 'onSelect'
    | 'onClose'
    | 'onCloseFile'
    | 'onCloseFileTab'
    | 'onActivateFile'
    | 'onKeepFile'
    | 'onCloseFolder'
    | 'openFileTab'
    | 'renderBrowserSurface'
    | 'renderTerminalSurface'
    | 'renderFilesSurface'
    | 'renderFileSurface'
    | 'renderFileProblems'
  >,
  {
    showing,
    exiting,
    dockBodyMounted,
    twoDepth,
    fileProblems,
    diffContext,
    changesTab,
  }: {
    showing: ReturnType<typeof paneDockShowing>;
    exiting: boolean;
    dockBodyMounted: boolean;
    twoDepth: boolean;
    fileProblems: ReturnType<typeof useSideFileProblems>;
    diffContext: DockDiffSurfaceContext;
    /** The session's Changes leads the file tabs. */
    changesTab: boolean;
  }
) {
  const {
    leafId,
    entry,
    focused,
    onFocusPane,
    isFileDirty,
    onSelect,
    onClose,
    onCloseFile,
    onCloseFileTab,
    onActivateFile,
    onKeepFile,
    onCloseFolder,
    openFileTab,
    renderBrowserSurface,
    renderTerminalSurface,
    renderFilesSurface,
    renderFileSurface,
    renderFileProblems,
  } = props;
  const { browserShowing, terminalShowing, fileShowing, filesShowing, diffShowing } = showing;
  const activeFile = paneDockActiveFile(entry);
  // Browser: standalone under the header — a
  // persistent layer stacked over the panel body. In the narrow 2뎁스 stage
  // the diff rides the same layer, with a back step to the list.
  const twoDepthDiff = dockBodyMounted && twoDepth && entry.diff && (
    <div className="workbench-side-surface-slot" data-surface-active={diffShowing ? 'true' : 'false'}>
      {renderDockDiffSurface(entry.diff, diffContext, true)}
    </div>
  );
  const browserSurface = dockBodyMounted ? (renderBrowserSurface?.(browserShowing, exiting) ?? null) : null;
  const terminalSurface = dockBodyMounted ? (renderTerminalSurface?.(terminalShowing, exiting) ?? null) : null;
  const leadingTab = changesTab ? { label: t('Changes'), onSelect: () => onSelect('session-diff') } : undefined;
  // Other tabs' file tabs held behind the front keep their editors only while
  // they hold unsaved edits; a clean one opens again when it is in front.
  const heldFiles = Object.values(entry.held ?? {}).flatMap((part) =>
    (part.files ?? []).filter((file) => isFileDirty?.(sideFileKey(file)))
  );
  const fileSurface =
    dockBodyMounted && (entry.files?.length || heldFiles.length) ? (
      <PaneDockFileSurface
        leafId={leafId}
        files={entry.files ?? []}
        heldFiles={heldFiles}
        onFocusPane={focused ? undefined : onFocusPane}
        activeFile={activeFile}
        active={fileShowing}
        problems={fileProblems}
        renderFileSurface={renderFileSurface}
        renderFileProblems={renderFileProblems}
        onActivateFile={onActivateFile}
        onCloseFileTab={onCloseFileTab}
        onKeepFile={onKeepFile}
        onCloseFile={onCloseFile}
        onClose={onClose}
        openFileTab={openFileTab}
        leadingTab={leadingTab}
      />
    ) : null;
  const filesSurface =
    dockBodyMounted && entry.folder
      ? (renderFilesSurface?.(entry.folder, filesShowing, { onClose: onCloseFolder ?? onClose }) ?? null)
      : null;
  const surfaces = (browserSurface || terminalSurface || fileSurface || filesSurface || twoDepthDiff) && (
    <>
      {filesSurface && <PaneDockSurfaceSlot active={filesShowing}>{filesSurface}</PaneDockSurfaceSlot>}
      {fileSurface}
      {browserSurface && (
        <div
          className="workbench-side-surface-slot"
          data-surface-active={browserShowing ? 'true' : 'false'}
          inert={browserShowing ? undefined : true}
          aria-hidden={browserShowing ? undefined : true}
        >
          {browserSurface}
        </div>
      )}
      {terminalSurface && <PaneDockSurfaceSlot active={terminalShowing}>{terminalSurface}</PaneDockSurfaceSlot>}
      {twoDepthDiff}
    </>
  );
  return surfaces;
}

/** The [diff | panel] row under the header: the paired diff column and the
 *  embedded right-side panel that hosts the views and the stacked surfaces. */
function renderPaneDockMain(
  props: Pick<
    PaneSideDockProps,
    'entry' | 'groups' | 'descriptors' | 'onSelect' | 'onMoveGroup' | 'onMoveView' | 'renderView'
  >,
  {
    openNow,
    closing,
    dockBodyMounted,
    diffColumn,
    surfaces,
    surfacesActive,
    asideWidth,
    panelWidthDrag,
    widthRange,
    widthResizable,
  }: {
    openNow: boolean;
    closing: boolean;
    dockBodyMounted: boolean;
    diffColumn: ReactNode;
    surfaces: ReactNode;
    surfacesActive: boolean;
    asideWidth: number;
    panelWidthDrag: ReturnType<typeof usePanelWidthDrag>;
    widthRange: typeof PANE_SIDE_DOCK_WIDTH_RANGE;
    widthResizable: boolean;
  }
) {
  const { entry, groups, descriptors, onSelect, onMoveGroup, onMoveView, renderView } = props;
  return (
    <div className="pane-side-dock-main">
      {diffColumn}
      <WorkbenchSidePanel
        side="right"
        embedded
        hideTabs
        open={openNow}
        exiting={closing}
        groups={groups}
        activeRoot={entry.view}
        surfaces={surfaces}
        surfacesActive={surfacesActive}
        descriptors={descriptors}
        onSelect={onSelect}
        onMoveGroup={onMoveGroup}
        onMoveView={onMoveView}
        widthOverride={asideWidth}
        onWidthDrag={panelWidthDrag}
        widthRange={widthRange}
        resizable={widthResizable}
        renderView={(id, active, titleDragProps) => (dockBodyMounted ? renderView(id, active, titleDragProps) : null)}
        hiddenKey={dockBodyMounted ? 'body' : ''}
      />
    </div>
  );
}

/** The two header pieces of the unit: the desktop chrome row and, on the
 *  focused phone sheet, the pane switch publisher. */
function renderPaneDockHeader(
  props: Pick<
    PaneSideDockProps,
    | 'leafId'
    | 'entry'
    | 'groups'
    | 'switchGroups'
    | 'descriptors'
    | 'focused'
    | 'sessionBound'
    | 'onOpenFiles'
    | 'onSelect'
    | 'onClose'
    | 'renderDiffHeaderControls'
  >,
  {
    openNow,
    mobileSheet,
    showing,
    diffView,
  }: {
    openNow: boolean;
    mobileSheet: boolean;
    showing: ReturnType<typeof paneDockShowing>;
    diffView: ReturnType<typeof useDiffViewState>;
  }
) {
  const {
    leafId,
    entry,
    groups,
    switchGroups,
    descriptors,
    focused,
    sessionBound = false,
    onOpenFiles,
    onSelect,
    onClose,
    renderDiffHeaderControls,
  } = props;
  const { sessionSurfaceShowing, sessionDiffPanelShowing, diffShowing, filesShowing } = showing;
  const activeRoot = paneDockActiveRoot(entry);
  // The phone sheet names the last shown child through its exit.
  const titleRoot = activeRoot ?? (mobileSheet ? entry.view : null);
  const activeDescriptor = titleRoot ? descriptors.get(titleRoot) : undefined;
  // Desktop: ONE header row per side surface. File, browser and terminal
  // draw their own DockHeaderRow in their slot; the dock draws the row
  // only for the diff and the panel views.
  const chromeRow = openNow && !sessionSurfaceShowing && !sessionDiffPanelShowing && (
    <PaneDockChromeRow
      diffShowing={diffShowing}
      diff={entry.diff}
      diffView={diffView}
      panelTitle={activeDescriptor?.title ?? activeDescriptor?.label ?? ''}
      titleHidden={mobileSheet && titleRoot === 'routines' && !diffShowing}
      leafId={leafId}
      renderDiffHeaderControls={renderDiffHeaderControls}
      onClose={onClose}
    />
  );
  // A session diff is the Changes view whatever panel it was opened over (the
  // desktop pair keeps that panel pressed; the phone shows the diff alone), so
  // the panel behind it (Profile …) is not the pane the switch marks as showing.
  const switchActiveRoot = diffShowing && entry.diff?.source === 'session' ? 'session-diff' : activeRoot;
  const phoneSwitch = mobileSheet && focused && (
    <PhoneDockSwitchPublisher
      groups={switchGroups ?? groups}
      keepVisualize={Boolean(switchGroups)}
      descriptors={descriptors}
      activeRoot={switchActiveRoot}
      sessionBound={sessionBound}
      files={onOpenFiles ? { active: filesShowing, onOpen: onOpenFiles } : undefined}
      onSelect={onSelect}
    />
  );
  return { chromeRow, phoneSwitch };
}

/** Expanded, the dock sheet is pinned to the measured expansion rect. */
function expandedHostStyle(
  dockExpanded: boolean,
  expandedRect: { left: number; top: number; width: number; height: number } | null | undefined
): CSSProperties | undefined {
  if (!dockExpanded || !expandedRect) return undefined;
  return {
    position: 'fixed',
    left: expandedRect.left,
    top: expandedRect.top,
    width: expandedRect.width,
    height: expandedRect.height,
  };
}

/** The entry with the panel view the body really shows: WorkbenchSidePanel
 *  falls back to the first group when the stored view (Profile remembered
 *  from a home thread) is not among this session's groups, so the header and
 *  showing flags must read that same view, not the stale one. */
export function paneDockEntryInGroups(
  entry: PaneSideDockEntry,
  groups: readonly WorkbenchSideViewGroup[]
): PaneSideDockEntry {
  if (entry.view === null || groups.length === 0) return entry;
  const view = entry.view;
  if (groups.some((group) => group.includes(view))) return entry;
  const first = groups[0]?.[0];
  return first === undefined ? entry : { ...entry, view: first };
}

export function PaneSideDock(rawProps: PaneSideDockProps) {
  const resolvedEntry = paneDockEntryInGroups(rawProps.entry, rawProps.groups);
  const props = resolvedEntry === rawProps.entry ? rawProps : { ...rawProps, entry: resolvedEntry };
  const {
    leafId,
    entry,
    groups,
    focused,
    sessionId = '',
    draftId = '',
    terminalSessionId = '',
    prewarm = false,
    onClose,
    onCloseDiff,
    onFocusPane,
    openFileTab,
  } = props;
  const openNow = paneDockOpenNow(entry);
  // The body shows in the commit that opens the sheet, with the sheet.
  const { panelMounted, dockBodyMounted } = useDockMounting(openNow, prewarm);
  const mobileSheet = useMobileRemoteSurface();
  const fileProblems = useSideFileProblems((entry.files?.length ?? 0) > 0);
  const changesStripHasTabs = useSessionDiffStripHasTabs(sessionId);
  // Geometry and semantics follow `openNow`.
  const showing = paneDockShowing(entry, openNow);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { browserShowing, terminalShowing, widthSurfaceShowing, diffShowing, sessionDiffPanelShowing } = showing;
  // The dock measures its own pane cell (see resolveDockLayout).
  const { dockPref, setDockPref, diffPref, setDiffPref } = useDockWidthPrefs();
  // The dock header mounts the diff controls; the pane body shares this state.
  const diffView = useDiffViewState('pane-side-dock');
  const inlineDock = useRef(false);
  inlineDock.current = false;
  useInlineDockFlag(hostRef, inlineDock);
  // The phone sheet slides closed with its last open body on it
  // (useSheetExit); what the body's children treat as showing follows that.
  const closing = useSheetExit(hostRef, openNow, mobileSheet);
  const lastOpenEntry = useRef(entry);
  if (openNow) lastOpenEntry.current = entry;
  const bodyProps = closing ? { ...props, entry: lastOpenEntry.current } : props;
  const bodyOpen = openNow || closing;
  const bodyShowing = paneDockShowing(bodyProps.entry, bodyOpen);
  // The header's toggle shows a session's or a draft's panel at every width, never on the phone.
  const railWanted = useSessionPanelShown() && Boolean(sessionId || draftId) && !mobileSheet;
  const railPref = useSessionRailWidth();
  const cellWidth = useDockCellWidth(hostRef, openNow || railWanted);
  // Desktop placement (Settings → Side panel position); the phone sheet keeps
  // its overlay grammar, so it always resolves to the right-hand layout.
  const desktopPlacement = useSidePanelPlacement();
  const placement = mobileSheet ? 'right' : desktopPlacement;
  const bottom = paneDockResizeAxis(placement) === 'height';
  const [heightPref, setHeightPref] = useState(() =>
    readStoredWidth(PANE_SIDE_DOCK_HEIGHT_KEY, PANE_SIDE_DOCK_MIN_HEIGHT, 4_000, PANE_SIDE_DOCK_DEFAULT_HEIGHT)
  );
  // The chat floor is held against the room the strip, Problems panel and
  // footer leave, re-measured as they open, close or resize.
  const dockRoom = useDockRoomHeight(hostRef, openNow && bottom);
  const dockHeight = clampPaneDockHeight(heightPref, dockRoom);
  const heightDrag = useDockHeightDrag({
    heightPref,
    setHeightPref,
    renderedHeight: dockHeight,
    room: dockRoom,
    storageKey: PANE_SIDE_DOCK_HEIGHT_KEY,
  });
  // The pane cell switches to its one-column grid (dock row under the chat)
  // through this flag rather than a :has() over the whole cell.
  const hostMounted = groups.length > 0;
  useLayoutEffect(() => {
    const cell = hostRef.current?.parentElement;
    if (!cell || !bottom || !hostMounted) return undefined;
    cell.dataset.dockPlacement = 'bottom';
    return () => {
      delete cell.dataset.dockPlacement;
    };
  }, [bottom, hostMounted]);
  const { expanded, expandedRect, restWidth, restHeight, toggleExpanded } = useDockExpansion(
    hostRef,
    entry.surface,
    entry.view,
    openNow
  );
  const panelWidthDrag = usePanelWidthDrag({
    dockPref,
    setDockPref,
    storageKey: PANE_SIDE_DOCK_WIDTH_KEY,
  });
  const diffResizeProps = useDiffColumnResize({
    diffPref,
    setDiffPref,
    getDiffWidth: () => diffWidth,
    minWidth: PANE_SIDE_DOCK_MIN_WIDTH,
    maxWidth: PANE_SIDE_DOCK_MAX_WIDTH,
    commitWidth: (width) => commitWidthPref(PANE_SIDE_DOCK_DIFF_WIDTH_KEY, width),
  });
  const retainedDiff = useRetainedDiff(entry.diff);
  // The hidden column keeps its last shown width: the diff library observes
  // its wrapper's size and re-lays out every row on any change, so a width
  // going to zero on close would cost as much as the unmount did.
  const shownDiffWidth = useRef(0);
  useDockCloseRequest(
    browserShowing || terminalShowing || sessionDiffPanelShowing,
    sessionDiffPanelShowing ? (entry.view ?? '') : entry.surface,
    focused,
    onClose,
    sessionId,
    terminalShowing ? terminalSessionId : ''
  );
  // The pane edge this render commits (recorded below); its layout effect
  // re-measures the transcripts it narrowed or widened in the same frame.
  const committedEdge = useRef('');
  const syncedEdge = useRef('');
  useLayoutEffect(() => {
    if (committedEdge.current === syncedEdge.current) return;
    syncedEdge.current = committedEdge.current;
    syncTranscriptWidths();
  });
  if (groups.length === 0) return null;
  const sheetFrame = mobileSheet ? 0 : PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;
  // Below the chat the unit owns the cell's width (its two borders and the
  // panel's column aside): no conversation floor to leave beside it, so it
  // never overlays.
  const layout = paneDockRailLayout({
    cellWidth,
    bottom,
    sheetFrame,
    rail: railWanted ? railPref : null,
    dock: {
      openNow,
      mobileSheet,
      diffShowing,
      sessionSurfaceShowing: widthSurfaceShowing,
      sessionMin: PANE_SIDE_DOCK_MIN_WIDTH,
      sessionPref: dockPref,
      panelPref: dockPref,
      diffPref,
    },
  });
  const { width: railWidth, reserve: railReserve, presentation: railPresentation } = layout.rail;
  // A dock open at the pane's side covers the panel (paneDockRailLayout).
  const railShown = railWanted && !(openNow && !bottom);
  const { diffDesired, twoDepth, pairShowing, overlay: sideOverlay, baseAsideWidth, diffWidth } = layout.dock;
  const overlay = sideOverlay && !bottom;
  const dockExpanded = expanded && openNow && !mobileSheet;
  // Exactly the host's data-open="true", data-overlay≠"true", data-expanded≠"true" below.
  inlineDock.current = openNow && !overlay && !dockExpanded;
  const dockExpandValue = mobileSheet ? null : { expanded: dockExpanded, toggle: toggleExpanded };
  const asideWidth = expandedAsideWidth(baseAsideWidth, expandedRect, pairShowing ? diffWidth : 0);
  committedEdge.current = `${placement}|${openNow}|${overlay}|${dockExpanded}|${asideWidth}|${pairShowing ? diffWidth : 0}|${bottom ? dockHeight : 0}|${railReserve}|${railPresentation}`;
  const diffContext: DockDiffSurfaceContext = {
    diffShowing: bodyShowing.diffShowing,
    diffView,
    openFileTab,
    onCloseDiff,
  };
  const surfaces = renderPaneDockSurfaces(bodyProps, {
    showing: bodyShowing,
    exiting: closing,
    dockBodyMounted,
    twoDepth,
    fileProblems,
    diffContext,
    changesTab: Boolean(bodyProps.changesTab) && changesStripHasTabs,
  });
  // File Diff: PAIRED to the LEFT of the panel view under the same header
  // selection; a project-tool click replaces the file in place. The narrow
  // 2뎁스 stage retires the pair column — the diff stacks over the panel.
  const columnDiff = entry.diff ?? retainedDiff;
  if (pairShowing && diffWidth > 0) shownDiffWidth.current = diffWidth;
  const columnWidth = pairShowing ? diffWidth : shownDiffWidth.current || diffDesired;
  const diffColumn = dockBodyMounted && columnDiff && !twoDepth && (
    <PaneDockDiffColumn showing={diffShowing} width={columnWidth} resizeProps={diffResizeProps}>
      {renderDockDiffSurface(columnDiff, diffContext)}
    </PaneDockDiffColumn>
  );
  const { chromeRow, phoneSwitch } = renderPaneDockHeader(bodyProps, {
    openNow: bodyOpen,
    mobileSheet,
    showing: bodyShowing,
    diffView,
  });
  // The spacer holds the dock's row (below) or column (beside) while expanded.
  const spacerStyle = bottom ? { height: restHeight.current } : { width: restWidth.current };
  return (
    <>
      <PaneDockExpandContext.Provider value={dockExpandValue}>
      {dockExpanded && expandedRect && <div className="pane-side-dock-spacer" style={spacerStyle} aria-hidden="true" />}
      <div
        className="pane-side-dock"
        ref={hostRef}
        data-pane-id={leafId}
        data-placement={placement}
        data-open={openNow ? 'true' : 'false'}
        data-overlay={overlay ? 'true' : 'false'}
        data-expanded={dockExpanded ? 'true' : 'false'}
        data-closing={closing ? 'true' : undefined}
        // The sliding-out sheet is already closed: nothing on it is reachable.
        inert={closing || undefined}
        aria-hidden={closing || undefined}
        style={
          expandedHostStyle(dockExpanded, expandedRect) ?? (bottom && openNow ? { height: dockHeight } : undefined)
        }
        onPointerDownCapture={
          focused
            ? undefined
            : (event) => {
                if (event.button === 0) onFocusPane();
              }
        }
      >
        {bottom && openNow && !dockExpanded && (
          // biome-ignore lint/a11y/useSemanticElements: a draggable resize handle, not a thematic break; <hr> brings its own border and margins.
          <div
            className="pane-side-dock-height-resize"
            role="separator"
            aria-orientation="horizontal"
            {...heightDrag}
          />
        )}
        {chromeRow}
        {phoneSwitch}
        {panelMounted &&
          renderPaneDockMain(bodyProps, {
            openNow,
            closing,
            dockBodyMounted,
            diffColumn,
            surfaces,
            surfacesActive: bodyShowing.sessionSurfaceShowing || twoDepth,
            asideWidth,
            panelWidthDrag,
            widthRange: PANE_SIDE_DOCK_WIDTH_RANGE,
            // Below the chat the panel fills the width; only the diff pair
            // keeps its width edge (between the diff and the panel).
            widthResizable: !bottom || pairShowing,
          })}
      </div>
      </PaneDockExpandContext.Provider>
      {railShown && (
        <SessionRailCard
          leafId={leafId}
          sessionId={sessionId}
          draftId={draftId}
          width={railWidth}
          reserve={railReserve}
          presentation={railPresentation}
          onFocusPane={focused ? undefined : onFocusPane}
        />
      )}
    </>
  );
}
