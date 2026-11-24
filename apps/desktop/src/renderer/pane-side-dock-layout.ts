import {
  PANE_SIDE_DOCK_MAX_WIDTH,
  PANE_SIDE_DOCK_MIN_WIDTH,
  paneDiffStacks,
  paneOverlayRoom,
  paneSidePresentation,
  paneSideRoom,
} from './pane-side-dock-model';
import { clampSessionRailWidth, type SessionRailFit, sessionRailFit } from './session-rail-layout';

export function resolveDockLayout({
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

const SESSION_RAIL_OFF: SessionRailFit = { width: 0, reserve: 0, presentation: 'beside' };

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
