// The session panel: cards right of a pane's reading column. How wide they
// may be there, what the conversation gives up for them, and the slot their
// body is drawn into.
import { useSyncExternalStore } from 'react';
import { PANE_SIDE_DOCK_SHEET_FRAME_WIDTH, SESSION_RAIL_WIDTH_KEY } from './pane-side-dock-model';

export const SESSION_RAIL_MIN_WIDTH = 300;
/** Until the user widens them, the cards take the least room they can. */
export const SESSION_RAIL_DEFAULT_WIDTH = SESSION_RAIL_MIN_WIDTH;
export const SESSION_RAIL_MAX_WIDTH = 560;
/** The transcript scrollbar's lane, right of the cards (session-rail.css). */
export const SESSION_RAIL_GAP = 8;
/** The conversation width that holds the reading column and composer in
 *  full: --pane-column's 800px floor (12-transcript.css) with 8px to spare
 *  either side, which leaves the composer 32px from each edge. */
export const PANE_READING_COLUMN_MAX = 816;

export function clampSessionRailWidth(width: number): number {
  const value = Number.isFinite(width) ? width : SESSION_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.max(SESSION_RAIL_MIN_WIDTH, Math.min(SESSION_RAIL_MAX_WIDTH, value)));
}

/** The cards in a pane cell `cellWidth` wide (the cell's width, not the
 *  window's): their `width`, 0 when they have no room, and the `reserve` the
 *  conversation gives up on its right for them. A dock beside the
 *  conversation keeps its width (`dockWidth`), and the reading column and
 *  composer keep their widest: the cards take what the two margins beside
 *  that column add up to, down to their own minimum. While the right margin
 *  alone holds them nothing moves (`reserve` 0); with less the conversation
 *  re-centres left of them. With no room they are not shown, and the composer
 *  keeps its island and controls. */
export function sessionRailFit({
  cellWidth,
  dockWidth,
  railPref,
}: {
  cellWidth: number;
  /** 0 when no dock is open beside the conversation (none, or one below it). */
  dockWidth: number;
  railPref: number;
}): { width: number; reserve: number } {
  const dockReserve = dockWidth > 0 ? PANE_SIDE_DOCK_SHEET_FRAME_WIDTH + dockWidth : 0;
  const margins = cellWidth - dockReserve - PANE_READING_COLUMN_MAX;
  const room = margins - SESSION_RAIL_GAP;
  if (room < SESSION_RAIL_MIN_WIDTH) return { width: 0, reserve: 0 };
  const width = Math.min(clampSessionRailWidth(railPref), room);
  const taken = width + SESSION_RAIL_GAP;
  return { width, reserve: margins / 2 >= taken ? 0 : taken };
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

// ── The slot each pane's card offers its conversation ────────────────────

/** The panel owner a New Task pane publishes before it has a session ('' for no draft). */
export function draftRailOwner(draftId: string): string {
  return draftId ? `draft:${draftId}` : '';
}

/** `sessionId`: the session the pane shows (or its New Task's draftRailOwner), the only one the panel draws. */
export type SessionRailSlot = { element: HTMLElement | null; sessionId: string };

const CLOSED_SLOT: SessionRailSlot = { element: null, sessionId: '' };
const slots = new Map<string, SessionRailSlot>();
const listeners = new Set<() => void>();

/** The card of pane `leafId`, or null when it is gone. */
export function publishSessionRailSlot(leafId: string, slot: SessionRailSlot | null): void {
  const current = slots.get(leafId) ?? CLOSED_SLOT;
  const next = slot ?? CLOSED_SLOT;
  if (current.element === next.element && current.sessionId === next.sessionId) return;
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
 *  pane's own, on-screen conversation of the session the pane shows owns the
 *  card (not a retained one, a parked one or a sub-agent's in the dock). The
 *  card takes that conversation's island and the controls under its composer;
 *  without it the composer keeps them. */
export function sessionRailHost(
  slot: SessionRailSlot,
  conversation: { sessionId: string; onScreen: boolean }
): HTMLElement | null {
  const owner = conversation.onScreen && Boolean(conversation.sessionId) && conversation.sessionId === slot.sessionId;
  return owner ? slot.element : null;
}

/** The session panel of the pane the caller is drawn in. */
export function useSessionRailSlot(leafId: string): SessionRailSlot {
  return useSyncExternalStore(
    subscribeSessionRailSlots,
    () => sessionRailSlot(leafId),
    () => CLOSED_SLOT
  );
}
