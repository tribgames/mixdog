// The desktop pet's per-device settings (userData/desktop-pet.json) and where
// its window goes: pinned (default) on the app window's message box; free, a
// saved spot per display, else the bottom-right of the work area of the app
// window's display; always clamped to a display's work area.
import { readFileSync } from 'node:fs';
import { writeJsonAtomicSync } from '../../../../src/runtime/shared/atomic-file.mjs';
import {
  DESKTOP_PET_ISLAND,
  DESKTOP_PET_ON_ISLAND_GAP,
  DESKTOP_PET_SCALE,
  DESKTOP_PET_SCALES,
  type DesktopPetComposer,
  type DesktopPetGeometry,
} from '../shared/desktop-pet';

export interface DesktopPetPrefs {
  enabled: boolean;
  /** Above every window; else owned by the app window (its layer). An older
   *  build's `alwaysOnTop` is not read: that was never a user's choice. */
  keepAbove: boolean;
  collapsed: boolean;
  /** Long replies turn their pages by themselves (on unless turned off). */
  autoAdvance: boolean;
  /** Replies close by themselves once read (on unless turned off). */
  autoClose: boolean;
  /** Pinned above the app window's message box (else free floating). */
  pinned: boolean;
  /** "Pin here": free but locked at its saved spot (never with `pinned`). */
  pinnedHere: boolean;
  /** "Free on screen": free and draggable anywhere on its displays, apart
   *  from the app window (owned by none, shown while the app is minimised,
   *  hidden or without a composer); never with `pinned` or `pinnedHere`. */
  onScreen: boolean;
  /** The bot's size in percent (one of DESKTOP_PET_SCALES). */
  scale: number;
  /** Saved free-floating window positions by display id. */
  positions: Record<string, { x: number; y: number }>;
  /** "Pin here", against the app window: null until first attached there
   *  (an older absolute spot is turned into one against the window then). */
  hereAnchor: PetHereAnchor | null;
}

/** Where a pinned-here window stands relative to the app window's content
 *  bounds: its top-left `dx` from the left edge (or, `right`, from the right
 *  edge, positive leftward), and `dy` from the top (or, `bottom`, the
 *  bottom), so it keeps its distance from the nearest corner. */
export interface PetHereAnchor {
  right: boolean;
  bottom: boolean;
  dx: number;
  dy: number;
  /** Measured against the composer card instead of the window's content
   *  bounds, so the bot keeps its place beside the box as the card moves. */
  composer?: true;
}

/** The anchor of a window at `point` (sprite box `sprite` inside it, both
 *  screen px) against `content`: the corner nearest the sprite's centre. */
export function petHereAnchor(point: { x: number; y: number }, sprite: PetRect, content: PetRect): PetHereAnchor {
  const right = sprite.x + sprite.width / 2 > content.x + content.width / 2;
  const bottom = sprite.y + sprite.height / 2 > content.y + content.height / 2;
  return {
    right,
    bottom,
    dx: Math.round(right ? content.x + content.width - point.x : point.x - content.x),
    dy: Math.round(bottom ? content.y + content.height - point.y : point.y - content.y),
  };
}

/** The window's top-left for `anchor` against `content` (screen px). */
export function petHerePosition(anchor: PetHereAnchor, content: PetRect): { x: number; y: number } {
  return {
    x: anchor.right ? content.x + content.width - anchor.dx : content.x + anchor.dx,
    y: anchor.bottom ? content.y + content.height - anchor.dy : content.y + anchor.dy,
  };
}

function readHereAnchor(value: unknown): PetHereAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const { right, bottom, dx, dy, composer } = value as Record<string, unknown>;
  if (typeof right !== 'boolean' || typeof bottom !== 'boolean') return null;
  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    Math.abs(dx as number) > 100_000 ||
    Math.abs(dy as number) > 100_000
  ) {
    return null;
  }
  const anchor = { right, bottom, dx: Math.round(dx as number), dy: Math.round(dy as number) };
  return composer === true ? { ...anchor, composer } : anchor;
}

/** On unless explicitly turned off: only a stored `enabled: false` keeps it
 *  off. Pinned unless explicitly unpinned. */
export const DEFAULT_DESKTOP_PET_PREFS: DesktopPetPrefs = Object.freeze({
  enabled: true,
  keepAbove: false,
  collapsed: false,
  autoAdvance: true,
  autoClose: true,
  pinned: true,
  pinnedHere: false,
  onScreen: false,
  scale: DESKTOP_PET_SCALE.default,
  positions: {},
  hereAnchor: null,
}) as DesktopPetPrefs;

/** Anything malformed reads as the default for that field. */
export function normalizeDesktopPetPrefs(value: unknown): DesktopPetPrefs {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const positions: DesktopPetPrefs['positions'] = {};
  const stored = raw.positions && typeof raw.positions === 'object' ? (raw.positions as Record<string, unknown>) : {};
  for (const [id, point] of Object.entries(stored)) {
    const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
    if (/^\d{1,20}$/.test(id) && Number.isFinite(x) && Number.isFinite(y)) {
      positions[id] = { x: Math.round(x as number), y: Math.round(y as number) };
    }
  }
  const pinned = raw.pinned !== false;
  return {
    enabled: raw.enabled !== false,
    keepAbove: raw.keepAbove === true,
    collapsed: raw.collapsed === true,
    autoAdvance: raw.autoAdvance !== false,
    autoClose: raw.autoClose !== false,
    pinned,
    pinnedHere: !pinned && raw.pinnedHere === true,
    onScreen: !pinned && raw.pinnedHere !== true && raw.onScreen === true,
    scale: DESKTOP_PET_SCALES.includes(raw.scale as number) ? (raw.scale as number) : DESKTOP_PET_SCALE.default,
    positions,
    hereAnchor: !pinned && raw.pinnedHere === true ? readHereAnchor(raw.hereAnchor) : null,
  };
}

export function readDesktopPetPrefs(path: string): DesktopPetPrefs {
  try {
    return normalizeDesktopPetPrefs(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...DEFAULT_DESKTOP_PET_PREFS, positions: {}, hereAnchor: null };
  }
}

export function writeDesktopPetPrefs(path: string, prefs: DesktopPetPrefs): void {
  writeJsonAtomicSync(path, prefs);
}

// ---- Placement ---------------------------------------------------------------

export interface PetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetDisplay {
  id: number;
  workArea: PetRect;
}

export interface PetSize {
  width: number;
  height: number;
}

/** How far inside the work area's edges the default spot sits. */
export const DESKTOP_PET_MARGIN = 16;

/** How far inside the composer card's right edge the pinned sprite box's
 *  right edge sits. The mascot art keeps one art pixel (3.5px at 56px) clear
 *  on each side, so its drawn right side lands about 5.5px inside the card. */
export const DESKTOP_PET_PIN_INSET = 2;

/** The line (CSS px) the pinned bot's visible feet stand on: the status
 *  island pill's bottom edge, or without a pill where that edge would be
 *  (its gap above the card's top). */
export function petIslandLine(composer: DesktopPetComposer): number {
  return composer.island ?? composer.y - DESKTOP_PET_ISLAND.gap;
}

/** The pinned window's spot: the sprite box's bottom (the mascot's visible
 *  feet: desktop-pet-main.tsx sets every look's lowest drawn row on it) on
 *  the island line (petIslandLine), its right edge a few px inside the card's (the sprite
 *  box, not the transparent window around it), at any scale. `content` is
 *  the app window's content bounds (screen px), `composer` the card in its
 *  CSS px, `zoom` the app's zoom factor, `geometry` the window and sprite at
 *  the bot's scale. (No card on screen: no pinned pet at all.) */
export function pinnedPetPosition(
  content: PetRect,
  composer: DesktopPetComposer,
  zoom: number,
  geometry: DesktopPetGeometry
): { x: number; y: number } {
  const { sprite, window } = geometry;
  const left = content.x + composer.x * zoom;
  const right = content.x + (composer.x + composer.width) * zoom;
  const restRight = right - DESKTOP_PET_PIN_INSET;
  // A pill running under the sprite box: the bot stands on top of it instead
  // of beside it on its baseline. The island goes compact first to clear the
  // bot (DesktopPetAppLayout.islandReserve), so this is the fallback for a
  // card too narrow even for the compact pill. Only the island's
  // rect decides (never where the bot ends up), so the switch happens once,
  // when the overlap changes.
  const span = composer.island === null ? undefined : composer.islandSpan;
  const overlaps =
    span !== undefined &&
    content.x + span.left * zoom < restRight &&
    content.x + span.right * zoom > restRight - sprite.size;
  let boxRight = restRight;
  let line = content.y + petIslandLine(composer) * zoom;
  if (overlaps) {
    // On the island as on the card: its right edge the inset inside the
    // island's right end, kept over the island and inside the card's span.
    const islandLeft = content.x + span.left * zoom;
    const islandRight = content.x + span.right * zoom;
    boxRight = Math.min(islandRight - DESKTOP_PET_PIN_INSET, restRight);
    boxRight = Math.max(boxRight, Math.min(islandLeft + DESKTOP_PET_PIN_INSET + sprite.size, restRight));
    boxRight = Math.max(boxRight, left + DESKTOP_PET_PIN_INSET + sprite.size);
    line = content.y + span.top * zoom - DESKTOP_PET_ON_ISLAND_GAP;
  }
  return {
    x: Math.round(boxRight - sprite.left - sprite.size),
    y: Math.round(line - (window.height - sprite.bottom)),
  };
}

/** Bottom-right of a work area, a little inside the margin. */
export function defaultPetPosition(workArea: PetRect, size: PetSize): { x: number; y: number } {
  return {
    x: workArea.x + workArea.width - size.width - DESKTOP_PET_MARGIN,
    y: workArea.y + workArea.height - size.height - DESKTOP_PET_MARGIN,
  };
}

/** `value` within [min, max]; a range that is empty (max < min) resolves to min. */
export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/** The whole window inside the work area. */
export function clampPetPosition(point: { x: number; y: number }, size: PetSize, workArea: PetRect) {
  return {
    x: Math.round(clampToRange(point.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clampToRange(point.y, workArea.y, workArea.y + workArea.height - size.height)),
  };
}

/** The display a window at `point` belongs to: the one holding its centre,
 *  else the nearest by centre distance. */
export function displayForPetPosition(
  point: { x: number; y: number },
  size: PetSize,
  displays: readonly PetDisplay[]
): PetDisplay | null {
  const cx = point.x + size.width / 2;
  const cy = point.y + size.height / 2;
  const inside = displays.find(
    ({ workArea: a }) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height
  );
  if (inside) return inside;
  let best: PetDisplay | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const a = display.workArea;
    const d = Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy);
    if (d < distance) {
      distance = d;
      best = display;
    }
  }
  return best;
}

/** A free (or pinned-here) window's spot (its unflipped top-left) inside
 *  the work area by the bot itself: its sprite box reaches the left, right
 *  and top edges, the window's transparent room (for its bubble, menu and
 *  quick message, each of which keeps to the screen on its own) running
 *  past the screen there; at the top the window flips, that room below the
 *  bot (desktop-pet-window.ts windowAt). At the bottom the box keeps its
 *  margin under the feet (the window's bottom on the work area's). */
export function clampFreePetPosition(point: { x: number; y: number }, geometry: DesktopPetGeometry, workArea: PetRect) {
  const { sprite, window } = geometry;
  const above = window.height - sprite.bottom - sprite.size;
  const box = clampPetPosition(
    { x: point.x + sprite.left, y: point.y + above },
    { width: sprite.size, height: sprite.size + sprite.bottom },
    workArea
  );
  return { x: box.x - sprite.left, y: box.y - above };
}

/** Where the pet window opens on `display`: its saved spot there (clamped),
 *  else the default corner. */
export function petPositionOn(display: PetDisplay, prefs: DesktopPetPrefs, geometry: DesktopPetGeometry) {
  const saved = prefs.positions[String(display.id)];
  return clampFreePetPosition(
    saved ?? defaultPetPosition(display.workArea, geometry.window),
    geometry,
    display.workArea
  );
}
