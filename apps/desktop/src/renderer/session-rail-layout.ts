// The session panel: a band at a pane's right edge, beside the conversation,
// over it, or over the whole pane. How wide it may be there, what the
// conversation gives up for it, and the slot its body is drawn into.
import { createContext, useSyncExternalStore } from 'react';
import {
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
  type PaneSidePresentation,
  paneSidePresentation,
  paneSideRoom,
  SESSION_RAIL_WIDTH_KEY,
} from './pane-side-dock-model';

export const SESSION_RAIL_MIN_WIDTH = 300;
/** Until the user widens it, the panel takes the least room it can. */
export const SESSION_RAIL_DEFAULT_WIDTH = SESSION_RAIL_MIN_WIDTH;
export const SESSION_RAIL_MAX_WIDTH = 560;
/** The panel's two 4px edges beside its width (session-rail.css). */
export const SESSION_RAIL_GAP = 8;

/** --pane-column in a conversation `width` wide, from 768px on
 *  (12-transcript.css): clamp(800px, 80cqi, 848px). */
export function paneReadingColumn(width: number): number {
  return Math.min(848, Math.max(800, 0.8 * width));
}

export function clampSessionRailWidth(width: number): number {
  const value = Number.isFinite(width) ? width : SESSION_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.max(SESSION_RAIL_MIN_WIDTH, Math.min(SESSION_RAIL_MAX_WIDTH, value)));
}

export type SessionRailFit = { width: number; reserve: number; presentation: PaneSidePresentation };

/** The panel in a pane cell `cellWidth` wide (the cell's width, not the
 *  window's), on the ladder every side-dock surface takes, with the same room
 *  and floor (paneSidePresentation): its `width`, the `reserve` the
 *  conversation gives up on its right for it, and its `presentation`. Beside
 *  the conversation while the conversation keeps its floor: the panel takes
 *  what the conversation leaves it there, never under its own minimum, which
 *  its rows need and which is above the ladder's floor. Nothing
 *  moves (`reserve` 0) while the transcript scroller, giving up the panel's
 *  band on both sides (session-rail.css --session-rail-over), still holds the
 *  column the pane gives its rows; with less the conversation re-centres
 *  left of it. Without that room it floats over the conversation at its own
 *  width, and in a pane too narrow for that it takes all of it. */
export function sessionRailFit({ cellWidth, railPref }: { cellWidth: number; railPref: number }): SessionRailFit {
  const { presentation, avail } = paneSidePresentation({
    cellWidth,
    room: paneSideRoom(cellWidth, PANE_SIDE_DOCK_SHEET_FRAME_WIDTH),
    columnMin: PANE_SIDE_DOCK_MIN_WIDTH,
    inlineFloor: PANE_SIDE_DOCK_MIN_WIDTH,
  });
  if (presentation === 'full') return { width: Math.max(0, cellWidth - SESSION_RAIL_GAP), reserve: 0, presentation };
  const pref = clampSessionRailWidth(railPref);
  if (presentation === 'overlay') {
    return { width: Math.max(SESSION_RAIL_MIN_WIDTH, Math.min(pref, avail)), reserve: 0, presentation };
  }
  const width = Math.max(SESSION_RAIL_MIN_WIDTH, Math.min(pref, paneSideRoom(cellWidth, SESSION_RAIL_GAP)));
  const taken = width + SESSION_RAIL_GAP;
  const reserve = cellWidth - 2 * taken >= paneReadingColumn(cellWidth) ? 0 : taken;
  return { width, reserve, presentation };
}

// ── The one width every pane's panel takes, live ─────────────────────────

let railWidthPref: number | null = null;
const widthListeners = new Set<() => void>();

function readSessionRailWidth(): number {
  if (railWidthPref === null) {
    let stored = Number.NaN;
    try {
      stored = Number(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY) || Number.NaN);
    } catch {
      // No storage: the default.
    }
    railWidthPref = clampSessionRailWidth(Number.isFinite(stored) ? stored : SESSION_RAIL_DEFAULT_WIDTH);
  }
  return railWidthPref;
}

/** Sets the panel width in every pane at once; `persist` once a resize ends. */
export function setSessionRailWidth(width: number, persist: boolean): void {
  const next = clampSessionRailWidth(width);
  if (persist) {
    try {
      window.localStorage.setItem(SESSION_RAIL_WIDTH_KEY, String(next));
    } catch {
      // The width holds for this window.
    }
  }
  if (next === readSessionRailWidth()) return;
  railWidthPref = next;
  for (const listener of [...widthListeners]) listener();
}

/** For tests: forgets the width read from storage. */
export function resetSessionRailWidth(): void {
  railWidthPref = null;
}

export function useSessionRailWidth(): number {
  return useSyncExternalStore(
    (listener) => {
      widthListeners.add(listener);
      return () => widthListeners.delete(listener);
    },
    readSessionRailWidth,
    () => SESSION_RAIL_DEFAULT_WIDTH
  );
}

// ── The slot each pane's panel offers its conversation ───────────────────

/** `sessionId`: the session the pane shows, the only one the panel draws;
 *  `draftId`: the New Task draft it shows instead ('' with a session);
 *  `covered`: a dock open at the pane's side covers the panel, which keeps
 *  what is drawn in it, scrolled where it was, for when the dock closes. */
export type SessionRailSlot = { element: HTMLElement | null; sessionId: string; draftId: string; covered?: boolean };

const CLOSED_SLOT: SessionRailSlot = { element: null, sessionId: '', draftId: '' };
const slots = new Map<string, SessionRailSlot>();
const listeners = new Set<() => void>();

/** The panel of pane `leafId`, or null when it is gone. */
export function publishSessionRailSlot(leafId: string, slot: SessionRailSlot | null): void {
  const current = slots.get(leafId) ?? CLOSED_SLOT;
  const next = slot ?? CLOSED_SLOT;
  if (
    current.element === next.element &&
    current.sessionId === next.sessionId &&
    current.draftId === next.draftId &&
    Boolean(current.covered) === Boolean(next.covered)
  ) {
    return;
  }
  if (slot) slots.set(leafId, slot);
  else slots.delete(leafId);
  for (const listener of [...listeners]) listener();
}

function subscribeSessionRailSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionRailSlot(leafId: string): SessionRailSlot {
  return slots.get(leafId) ?? CLOSED_SLOT;
}

/** The element one conversation draws the panel into, or null: only the
 *  pane's own, on-screen conversation of the session or New Task draft the
 *  pane shows owns the panel (not a retained one, a parked one or a
 *  sub-agent's in the dock). The panel takes that conversation's island and
 *  the controls under its composer; without it the composer keeps them. */
export function sessionRailHost(
  slot: SessionRailSlot,
  conversation: { sessionId: string; draftId?: string; onScreen: boolean }
): HTMLElement | null {
  const { sessionId, draftId = '', onScreen } = conversation;
  const shown = sessionId ? sessionId === slot.sessionId : Boolean(draftId) && draftId === slot.draftId;
  return onScreen && shown ? slot.element : null;
}

/** A conversation's part in its pane's hand-over (pane-surface-model.ts): the
 *  one switched to, laid out unseen until it can be shown (`incoming`), or the
 *  one the pane still shows meanwhile (`outgoing`). */
export type PaneHandOver = 'incoming' | 'outgoing' | null;

export const PaneHandOverContext = createContext<PaneHandOver>(null);

/** One conversation's part in its pane's panel: `host`, the element it draws
 *  the panel into, or null; `taken`, its composer leaves the panel its island
 *  and controls. The slot names the pane's active tab, which during a
 *  hand-over is already the conversation switched to while the pane still
 *  shows the one before it: that one keeps the panel until the pane hands
 *  over, and the one switched to is laid out as the panel will leave it,
 *  drawing nothing until then. A covered panel is still drawn in, and takes
 *  nothing from the composer. */
export function sessionRailPlace(
  slot: SessionRailSlot,
  conversation: { sessionId: string; draftId?: string; onScreen: boolean; handOver: PaneHandOver }
): { host: HTMLElement | null; taken: boolean } {
  if (conversation.handOver === 'outgoing') {
    const host = conversation.onScreen ? slot.element : null;
    return { host, taken: Boolean(host) && !slot.covered };
  }
  const own = sessionRailHost(slot, conversation);
  return { host: conversation.handOver === 'incoming' ? null : own, taken: Boolean(own) && !slot.covered };
}

/** The session panel of the pane the caller is drawn in. */
export function useSessionRailSlot(leafId: string): SessionRailSlot {
  return useSyncExternalStore(
    subscribeSessionRailSlots,
    () => sessionRailSlot(leafId),
    () => CLOSED_SLOT
  );
}
