// The session panel's column beside a pane: how it fits next to the dock and
// the conversation, and the slot its body is drawn into.
import { useSyncExternalStore } from 'react';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
import { PANE_SIDE_DOCK_SHEET_FRAME_WIDTH, SESSION_RAIL_WIDTH_KEY } from './pane-side-dock-model';

export const SESSION_RAIL_DEFAULT_WIDTH = 400;
export const SESSION_RAIL_MIN_WIDTH = 300;
export const SESSION_RAIL_MAX_WIDTH = 560;

/** `column`: a sheet of its own at the pane's right edge; `raised`: shown
 *  over the right edge of the pane (too little room for a column); `off`:
 *  not shown. */
export type SessionRailMode = 'off' | 'column' | 'raised';

export function clampSessionRailWidth(width: number): number {
  const value = Number.isFinite(width) ? width : SESSION_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.max(SESSION_RAIL_MIN_WIDTH, Math.min(SESSION_RAIL_MAX_WIDTH, value)));
}

/** Where the panel goes in a pane cell `cellWidth` wide (the cell's width,
 *  not the window's). The conversation keeps its floor and a dock beside it
 *  the width it has without the panel (`dockWidth`): the panel is a column
 *  in the room they leave, down to its own minimum. With less room it is
 *  `off` beside a dock (the dock is the pane's side panel then, and the
 *  composer keeps its controls) and raised over the pane with no dock.
 *  `dockRoom` is the width the dock may take beside the conversation. */
export function sessionRailFit({
  cellWidth,
  dockWidth,
  railPref,
}: {
  cellWidth: number;
  /** 0 when no dock is open beside the conversation (none, or one below it). */
  dockWidth: number;
  railPref: number;
}): { mode: SessionRailMode; width: number; dockRoom: number } {
  const frame = PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;
  const preferred = clampSessionRailWidth(railPref);
  const dockReserve = dockWidth > 0 ? frame + dockWidth : 0;
  const room = cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - dockReserve - frame;
  const withoutRail = cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - frame;
  if (room < SESSION_RAIL_MIN_WIDTH) {
    if (dockWidth > 0) return { mode: 'off', width: 0, dockRoom: withoutRail };
    return { mode: 'raised', width: Math.max(0, Math.min(preferred, cellWidth - 2 * frame)), dockRoom: withoutRail };
  }
  const width = Math.min(preferred, room);
  return { mode: 'column', width, dockRoom: withoutRail - width - frame };
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

// ── The slot each pane's column offers its conversation ──────────────────

/** `sessionId`: the session the pane shows, the only one the panel draws. */
export type SessionRailSlot = { element: HTMLElement | null; mode: SessionRailMode; sessionId: string };

const CLOSED_SLOT: SessionRailSlot = { element: null, mode: 'off', sessionId: '' };
const slots = new Map<string, SessionRailSlot>();
const listeners = new Set<() => void>();

/** The column (or raised panel) of pane `leafId`, or null when it is gone. */
export function publishSessionRailSlot(leafId: string, slot: SessionRailSlot | null): void {
  const current = slots.get(leafId) ?? CLOSED_SLOT;
  const next = slot ?? CLOSED_SLOT;
  if (current.element === next.element && current.mode === next.mode && current.sessionId === next.sessionId) return;
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

/** What the panel is to one conversation: only the pane's own, on-screen
 *  conversation of the session the pane shows owns it (a retained one, a
 *  parked one or a sub-agent's in the dock is `off`). As a `column` it takes
 *  that conversation's island and the controls under its composer; `raised`
 *  or `off`, the composer keeps them. */
export function sessionRailComposerMode(
  slot: SessionRailSlot,
  conversation: { sessionId: string; onScreen: boolean }
): SessionRailMode {
  const owner = conversation.onScreen && Boolean(conversation.sessionId) && conversation.sessionId === slot.sessionId;
  return owner && slot.element ? slot.mode : 'off';
}

/** The session panel of the pane the caller is drawn in. */
export function useSessionRailSlot(leafId: string): SessionRailSlot {
  return useSyncExternalStore(
    subscribeSessionRailSlots,
    () => sessionRailSlot(leafId),
    () => CLOSED_SLOT
  );
}

// ── Presses inside the panel ─────────────────────────────────────────────

/** A raised panel closes on a press outside it. Its body is drawn from the
 *  conversation and its menus are portalled to the body, so "inside" is
 *  what any of them marked on its way through React, not the DOM. */
const insidePresses = new WeakSet<Event>();

export function markSessionRailPress(event: Event): void {
  insidePresses.add(event);
}

export function sessionRailPress(event: Event): boolean {
  return insidePresses.has(event);
}
