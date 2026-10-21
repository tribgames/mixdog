// The desktop pet: a small always-on-top window (main/desktop-pet-window.ts)
// that is a side chat with Mixy: Mixy's mascot with a speech bubble of Mixy's
// home chat. The app window's renderer derives that state and publishes it;
// main relays it to the pet window. Nothing here carries session content
// beyond the plain text of Mixy's latest reply.

/** The app window's view of the pet setting. */
/** The overlay's settings, shown alike in Settings → General and in the
 *  pet's own menu. */
export interface DesktopPetConfig {
  enabled: boolean;
  /** Stands on the message box and cannot be dragged (default on). */
  pinned: boolean;
  /** "Pin here": locked at its free spot, not draggable; never together
   *  with `pinned` (turning one on turns the other off). */
  pinnedHere: boolean;
  /** Above every window; else it follows the app window's layer (default). */
  keepAbove: boolean;
  /** Only the pet shows, no bubble. */
  collapsed: boolean;
  /** A long reply turns its pages by itself at reading pace (default on). */
  autoAdvance: boolean;
  /** A reply closes by itself once read (default on); off, it stays until
   *  closed, opened in the app or answered. */
  autoClose: boolean;
  /** The bot's size in percent (DESKTOP_PET_SCALE; default 100). */
  scale: number;
}

/** The overlay options Settings can set (besides on/off). */
export const DESKTOP_PET_OPTIONS = [
  'pinned',
  'pinnedHere',
  'keepAbove',
  'collapsed',
  'autoAdvance',
  'autoClose',
] as const;
export type DesktopPetOption = (typeof DESKTOP_PET_OPTIONS)[number];

/** What the speech bubble shows: Mixy's latest reply as plain text, or a
 *  comic symbol while there is no reply to show. */
export type DesktopPetBubble =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'approval' }
  | { kind: 'reply'; key: string; text: string };

/** One face: an agent id, its name and its stored avatar look. */
export interface DesktopPetMember {
  id: string;
  name: string;
  avatar: unknown;
}

/** The followed chat's face: one bot, or a room's members (up to four shown). */
export interface DesktopPetFace {
  room: boolean;
  members: DesktopPetMember[];
}

/** Published by the app window for the followed session. */
export interface DesktopPetState {
  sessionId: string;
  bubble: DesktopPetBubble;
  face: DesktopPetFace;
  /** Mixy's chat is the app window's focused view: the pet stays quiet (no
   *  bubble; the chat shows the same) and a click focuses its composer. */
  quiet: boolean;
}

/** The app's chat look, read off its composer: light/dark and the resolved
 *  values of the tokens the pet draws with (DESKTOP_PET_THEME_VARS). */
export interface DesktopPetTheme {
  scheme: 'light' | 'dark';
  vars: Record<string, string>;
}

/** The tokens the overlay (bubble, quick message, send button, menu) uses:
 *  the same the app's composer, message bubbles and context menus use. */
export const DESKTOP_PET_THEME_VARS = [
  '--mx-composer-surface',
  '--mx-border',
  '--mx-border-strong',
  '--mx-text',
  '--mx-text-muted',
  '--mx-text-faint',
  '--mx-warning',
  '--mx-focus',
  '--mx-accent',
  '--mx-hover',
  '--mx-pressed',
  '--mx-bg-base',
  '--mx-bg-layer-1',
  '--mx-bg-layer-2',
  '--mx-popup-bg',
  '--mx-popup-border',
  '--mx-popup-shadow',
  '--mx-popup-radius',
  '--mx-list-focus-ring',
  '--mx-font-sans',
  '--mx-font-ui',
  '--mx-font-meta',
] as const;

/** The pet's own menu (rendered in its window): what each item asks main to do. */
export const DESKTOP_PET_COMMANDS = [
  'open',
  'settings',
  'collapse',
  'keep-above',
  'pin',
  'pin-here',
  'reset',
  'off',
] as const;
export type DesktopPetCommand = (typeof DESKTOP_PET_COMMANDS)[number];

/** What the pet window draws: the published state plus the pet's own settings. */
export interface DesktopPetView extends DesktopPetState {
  collapsed: boolean;
  autoAdvance: boolean;
  autoClose: boolean;
  keepAbove: boolean;
  pinned: boolean;
  pinnedHere: boolean;
  /** The bot's size in percent: the window was made for it (desktopPetGeometry). */
  scale: number;
  theme: DesktopPetTheme | null;
  /** The window is on screen (its idle animation runs only then). */
  visible: boolean;
  /** How much of the window, from its left (window px), lies on its
   *  display's work area: the menu opens on the pet's left when the right
   *  would run off screen. */
  screenRight: number;
  /** The span of the window (window px, from its left) the bubble stays in
   *  (16px inside): the app window's content while the bot stands on it,
   *  else the display's work area. */
  bubbleSpan: { left: number; right: number };
  /** The app's open menus, popovers and tooltips over the window (window
   *  px): cut out of all the pet draws, so they show through and take the
   *  pointer there. */
  cutouts: DesktopPetRect[];
}

/** The app's open floating layers (app → main). */
export interface DesktopPetLayers {
  /** A modal with the app's backdrop is open: the pet hides over the app window. */
  backdrop: boolean;
  /** The transient layers on screen (menus, listboxes, popovers, tooltips,
   *  non-backdrop dialogs) in the app's CSS px: cut out of the pet. */
  rects: DesktopPetRect[];
}

/** The app window's composer card, in that window's CSS pixels (its viewport):
 *  the pinned pet stands on its top-right. */
export interface DesktopPetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The composer card (DesktopPetRect) plus the bottom edge of the status
 *  island's pill above it (same CSS px), or null when no pill shows: the
 *  pinned bot's visible feet stand on that line (else DESKTOP_PET_ISLAND.gap
 *  above the card). */
export interface DesktopPetComposer extends DesktopPetRect {
  island: number | null;
  /** The pill's horizontal extent and top edge (same CSS px), sent with
   *  `island`: a pill wide enough to reach under the pinned bot puts the bot
   *  on top of it (DESKTOP_PET_ON_ISLAND_GAP above its top edge). */
  islandSpan?: { left: number; right: number; top: number };
  /** The focused pane's transcript column (same CSS px): the scroller's
   *  left and right, and the line its last row ends on. */
  transcript?: { left: number; right: number; bottom: number };
}

/** How far above a wide island pill's top edge the pinned bot's feet stand. */
export const DESKTOP_PET_ON_ISLAND_GAP = 2;

/** Pointer drag of the pet window, in screen pixels. */
export interface DesktopPetDrag {
  phase: 'start' | 'move' | 'end';
  screenX: number;
  screenY: number;
}

/** Channels on the app window's own webContents.ipc (never the global
 *  ipcMain). The pet window's are DESKTOP_PET_WINDOW_IPC (desktop-pet-bridge.ts):
 *  kept apart so the two sandboxed preloads share no chunk. */
export const DESKTOP_PET_IPC = {
  /** app → main: Mixy's chat state. */
  publish: 'mixdog-pet:publish',
  /** app → main: the focused pane's composer card (DesktopPetRect | null). */
  composer: 'mixdog-pet:composer',
  /** app → main: the chat look (DesktopPetTheme). */
  theme: 'mixdog-pet:theme',
  /** app → main: the app's open floating layers (DesktopPetLayers): a
   *  backdrop modal hides the pet, menus, popovers and tooltips cut it. */
  layers: 'mixdog-pet:layers',
  /** app → main: the representative bot exists (boolean). Without it the
   *  overlay does not appear, whatever the setting says. */
  available: 'mixdog-pet:available',
  /** app → main (invoke): the setting. */
  getConfig: 'mixdog-pet:get-config',
  setEnabled: 'mixdog-pet:set-enabled',
  setOption: 'mixdog-pet:set-option',
  setScale: 'mixdog-pet:set-scale',
  resetPosition: 'mixdog-pet:reset-position',
  /** main → app: the setting changed (menu, Hide pet). */
  config: 'mixdog-pet:config',
  /** main → app: the pet menu's Settings item: open Settings → Bots. */
  openSettings: 'mixdog-pet:open-settings',
  /** main → app: where the composer-pinned bot stands (DesktopPetAppLayout,
   *  sent on change). */
  appLayout: 'mixdog-pet:app-layout',
} as const;

/** What the app window lays out around the composer-pinned bot. */
export interface DesktopPetAppLayout {
  /** On screen over the transcript's column: the live status row drops its
   *  token readout (html[data-pet-over-transcript]). */
  overTranscript: boolean;
  /** The width (the app's CSS px) the bot takes at the composer card's
   *  right end, its clearance included, while it stands there; else 0. The
   *  focused composer's island goes compact when its full labels would run
   *  under it. */
  islandReserve: number;
}

/** Clearance (CSS px) the island keeps from the composer-pinned bot's
 *  visible art. */
export const DESKTOP_PET_ISLAND_CLEARANCE = 4;

/** DesktopPetAppLayout from the wire: anything else reads as nothing. */
export function desktopPetAppLayout(value: unknown): DesktopPetAppLayout {
  const { overTranscript, islandReserve } = (value ?? {}) as { overTranscript?: unknown; islandReserve?: unknown };
  const reserve =
    typeof islandReserve === 'number' && Number.isFinite(islandReserve) && islandReserve > 0
      ? Math.min(Math.round(islandReserve), 10_000)
      : 0;
  return { overTranscript: overTranscript === true, islandReserve: reserve };
}

/** The room for the pet's menu (desktop-pet-menu.tsx): its rows (eight items
 *  and the Size row) at its fixed 28px row (desktop-pet.css), the 5px of
 *  each of its three dividers, the 6px inset and hairline border on both
 *  sides (01-tokens.css) come to 281px; the rest is headroom. */
export const DESKTOP_PET_MENU = { rows: 9, dividers: 3, height: 300 } as const;

/** The pet window's size, never changed while it lives: the bubble (four
 *  lines, growing up and right from the pet's head), the 40px the pet hops
 *  up onto the quick message, the pet and a small margin, room for its
 *  menu on either side of the pet, and the menu's full height (4px inside
 *  the window top and bottom). */
export const DESKTOP_PET_WINDOW = { width: 512, height: 308 } as const;

/** Above the sprite box: the bubble and the quick message's hop (the 100%
 *  window before the menu grew, 212px, less the box and its 8px). */
const DESKTOP_PET_BUBBLE_ROOM = 148;

/** Where the pet sprite box stands in the window (desktop-pet.css
 *  .skin-companion-stack): `left` from the window's left, `bottom` from its
 *  bottom, `size` square. The mascot's feet are the box's bottom edge. The
 *  quick message (240px) is centred under it. */
export const DESKTOP_PET_SPRITE = { left: 228, bottom: 8, size: 56 } as const;

/** The part of the window that must stay on screen when pinned: from its left
 *  (the menu's room on the pet's left) through the quick message centred
 *  under the pet (the bubble and the right-hand menu room may run past the
 *  edge rather than the pet leaving the composer). */
export const DESKTOP_PET_CORE_WIDTH = 384;

/** The bot's size choices, in percent of the 100% sprite box. */
export const DESKTOP_PET_SCALE = { min: 50, max: 200, step: 10, default: 100 } as const;
export const DESKTOP_PET_SCALES: readonly number[] = Array.from(
  { length: (DESKTOP_PET_SCALE.max - DESKTOP_PET_SCALE.min) / DESKTOP_PET_SCALE.step + 1 },
  (_, index) => DESKTOP_PET_SCALE.min + index * DESKTOP_PET_SCALE.step
);

/** The status island above the composer (15-composer.css): its pill's height
 *  and its gap above the card. Without a pill on screen the pinned bot's
 *  feet stand where the pill's bottom edge would. */
export const DESKTOP_PET_ISLAND = { pillHeight: 34, gap: 12 } as const;

export interface DesktopPetGeometry {
  /** The window's size at this scale, never changed while it lives. */
  window: { width: number; height: number };
  /** The sprite box in it (as DESKTOP_PET_SPRITE). */
  sprite: { left: number; bottom: number; size: number };
  /** As DESKTOP_PET_CORE_WIDTH: through the quick message centred under the bot. */
  coreWidth: number;
}

/** The window and sprite box for a bot at `scale` percent. Only the sprite
 *  scales: the bubble, the quick message and the menu keep their size and
 *  their room (above the head, beside the box), so the window grows wider
 *  with the sprite above 100% and keeps the 100% size below it; it is tall
 *  enough for the whole menu and for the bubble above the head. The box is a
 *  multiple of 4px (a quarter of an art pixel of the 16-pixel mascot), its
 *  centre a whole pixel. */
export function desktopPetGeometry(scale: number = DESKTOP_PET_SCALE.default): DesktopPetGeometry {
  const base = DESKTOP_PET_SPRITE.size;
  const size = 4 * Math.round((base / 4) * (scale / 100));
  const room = Math.max(size, base);
  const height = Math.max(DESKTOP_PET_WINDOW.height, DESKTOP_PET_SPRITE.bottom + room + DESKTOP_PET_BUBBLE_ROOM);
  return {
    window: { width: DESKTOP_PET_WINDOW.width - base + room, height },
    sprite: { left: DESKTOP_PET_SPRITE.left, bottom: DESKTOP_PET_SPRITE.bottom, size },
    coreWidth: DESKTOP_PET_CORE_WIDTH - base / 2 + size / 2,
  };
}

/** The pet's menu (desktop-pet.css .desktop-pet-menu): this far past the
 *  sprite box on the side it opens, and kept this far inside the window. */
export const DESKTOP_PET_MENU_GAP = 8;
export const DESKTOP_PET_MENU_MARGIN = 4;

/** Most floating layers the app reports at once. */
export const DESKTOP_PET_MAX_LAYERS = 32;

/** Most of Mixy's reply the bubble carries: a long reply is paged, so the
 *  bubble holds the whole of an ordinary reply (the quick message's bound). */
export const DESKTOP_PET_REPLY_MAX = 4000;

/** Longest quick message the pet window may send. */
export const DESKTOP_PET_MAX_TEXT = 4000;
