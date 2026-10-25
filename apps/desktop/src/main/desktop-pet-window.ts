// The desktop pet window: a small frameless, transparent, always-on-top
// window that is a side chat with Mixy (desktop-pet.html). The app window's
// renderer publishes the state of Mixy's home chat and its composer card's
// rect; this module relays the state, owns the window's life (on with the
// setting, gone when off or at quit), its place, its menu, and its send path
// (the composer's own: submitToSession).
// Place: pinned (the default), the pet stands on the app window's message box
// and follows it, hidden while the app window is minimised or hidden; free (a
// drag unpins it), it stays on screen on its own, at a spot saved per display.
// Either way it is clamped to a work area, back onto the primary display when
// its own is removed.
import { DESKTOP_PET_WINDOW_IPC } from '../shared/desktop-pet-bridge';
import {
  DESKTOP_PET_IPC as DESKTOP_PET_APP_IPC,
  DESKTOP_PET_ISLAND_CLEARANCE,
  desktopPetGeometry,
  type DesktopPetAppLayout,
  type DesktopPetCommand,
  type DesktopPetComposer,
  type DesktopPetConfig,
  type DesktopPetDrag,
  type DesktopPetRect,
  type DesktopPetState,
  type DesktopPetTheme,
  type DesktopPetView,
} from '../shared/desktop-pet';
import { petMascotCells } from '../shared/desktop-pet-art';
import {
  clampFreePetPosition,
  clampPetPosition,
  DESKTOP_PET_PIN_INSET,
  type DesktopPetPrefs,
  displayForPetPosition,
  type PetDisplay,
  petHereAnchor,
  petHerePosition,
  petPositionOn,
  pinnedPetPosition,
  readDesktopPetPrefs,
  writeDesktopPetPrefs,
} from './desktop-pet-store';
import {
  requiredDesktopPetCommand,
  requiredDesktopPetComposer,
  requiredDesktopPetComposerRect,
  requiredDesktopPetDrag,
  requiredDesktopPetLayers,
  requiredDesktopPetNudge,
  requiredDesktopPetOption,
  requiredDesktopPetScale,
  requiredDesktopPetState,
  requiredDesktopPetText,
  requiredDesktopPetTheme,
} from './ipc-validation';

type Listener = (event: { sender?: unknown }, ...args: unknown[]) => void;
type Handler = (event: { sender?: unknown }, ...args: unknown[]) => unknown;

/** The part of a webContents this module uses (Electron's WebContents). */
export interface PetWebContents {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  ipc: {
    on(channel: string, listener: Listener): unknown;
    handle(channel: string, handler: Handler): void;
    removeListener(channel: string, listener: Listener): unknown;
    removeHandler(channel: string): void;
  };
}

/** The part of a BrowserWindow this module uses. */
export interface PetWindow {
  webContents: PetWebContents;
  isDestroyed(): boolean;
  destroy(): void;
  getPosition(): number[];
  /** Bounds, not a position: a move across displays with different scaling
   *  must not resize the window. */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  on(event: 'blur' | 'closed', listener: () => void): unknown;
}

export interface PetScreen {
  getAllDisplays(): PetDisplay[];
  getPrimaryDisplay(): PetDisplay;
  getDisplayMatching(rect: { x: number; y: number; width: number; height: number }): PetDisplay;
  on(event: 'display-removed' | 'display-metrics-changed', listener: () => void): unknown;
  removeListener(event: 'display-removed' | 'display-metrics-changed', listener: () => void): unknown;
}

/** App-window events the pinned pet follows. */
const APP_WINDOW_EVENTS = [
  'move',
  'moved',
  'resize',
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
  'minimize',
  'restore',
  'hide',
  'show',
] as const;
type AppWindowEvent = (typeof APP_WINDOW_EVENTS)[number] | 'closed';

/** The app page replaced (a reload committed: `did-navigate` fires only for
 *  a main-frame, cross-document navigation) or its renderer gone. Not
 *  `did-start-loading`/`did-start-navigation`: Electron fires those for an
 *  iframe loading in the chat, history.pushState and a navigation the
 *  window's guard then blocks, none of which replaces the page. */
type AppContentsEvent = 'did-navigate' | 'render-process-gone';

/** The app window, as far as the pet needs it. */
export interface PetAppWindow {
  webContents: PetWebContents & {
    getZoomFactor(): number;
    on(event: AppContentsEvent, listener: () => void): unknown;
    removeListener(event: AppContentsEvent, listener: () => void): unknown;
  };
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: AppWindowEvent, listener: () => void): unknown;
  removeListener(event: AppWindowEvent, listener: () => void): unknown;
}

export interface DesktopPetDeps {
  prefsPath: string;
  screen: PetScreen;
  /** A new, hidden, unfocusable pet window at `bounds` (BrowserWindow with
   *  the pet preload) on its layer: owned by `parent` (follow the app
   *  window), or with no owner and always on top. The layer is set only
   *  here: changing a live window's owner or topmost state makes Windows
   *  move the app window's focus (the Settings dialog flickered with it). */
  createWindow(
    bounds: { x: number; y: number; width: number; height: number },
    layer: { parent: PetAppWindow | null; alwaysOnTop: boolean }
  ): PetWindow;
  /** Load desktop-pet.html into it. */
  load(window: PetWindow): Promise<void>;
  /** The composer's own send path for a session (submitToSession). */
  submit(sessionId: string, text: string): Promise<boolean>;
  /** Bring the app window to front, and open `sessionId` there when given. */
  openApp(sessionId: string): void;
  /** The chat's latest reply was read in the overlay: the app's own shared
   *  read cursor for that session (what viewing the chat records). */
  markRead(sessionId: string): void;
  /** The system clipboard (the pet window has no clipboard permission). */
  copyText(text: string): void;
  /** An agent's custom picture (getAgentAvatarImage: data URLs by state),
   *  for the pet window, which has no capability bridge of its own. */
  avatarImage?(agentId: string): Promise<unknown>;
  readPrefs?: (path: string) => DesktopPetPrefs;
  writePrefs?: (path: string, prefs: DesktopPetPrefs) => void;
}

const DESKTOP_PET_IPC = { ...DESKTOP_PET_APP_IPC, ...DESKTOP_PET_WINDOW_IPC };
const IDLE_STATE: DesktopPetState = {
  sessionId: '',
  bubble: { kind: 'idle' },
  face: { room: false, members: [] },
  quiet: false,
};

/** `parse` then `apply`; a malformed value is dropped. */
function applyValid<T>(parse: (value: unknown) => T, apply: (parsed: T) => void): Listener {
  return (_event, value) => {
    let parsed: T;
    try {
      parsed = parse(value);
    } catch {
      return;
    }
    apply(parsed);
  };
}

/** Everything the overlay shares across its parts: one object, read and written by the module-level functions below. */
interface PetContext {
  deps: DesktopPetDeps;
  writePrefs: (path: string, prefs: DesktopPetPrefs) => void;
  prefs: DesktopPetPrefs;
  state: DesktopPetState;
  pet: PetWindow | null;
  app: PetAppWindow | null;
  detachApp: (() => void) | null;
  disposed: boolean;
  /** start() ran (the app is ready). */
  started: boolean;
  /** The representative bot exists (the app window's answer; unknown = no):
   *  without it the overlay does not appear, the stored setting unchanged. */
  available: boolean;
  /** The current pet window finished loading, and its renderer drew the pet's
   *  first frame: only both together let it show. */
  loaded: boolean;
  painted: boolean;
  /** The app window's composer card (its CSS px), or null when none shows. */
  composer: DesktopPetComposer | null;
  /** The app renderer published its first chat state since it (re)loaded:
   *  until then the app window may still show its dark boot screen. */
  published: boolean;
  /** The app's chat look, relayed to the pet window. */
  theme: DesktopPetTheme | null;
  /** The app's open transient layers (its CSS px): cut out of the pet. */
  layers: DesktopPetRect[];
  /** A modal with the app's backdrop is open: the pet hides over the app window. */
  backdrop: boolean;
  /** What the pet draws in its window (window px): the sprite, bubble, input. */
  area: DesktopPetRect | null;
  drag: { x: number; y: number; screenX: number; screenY: number } | null;
  /** The window's on-screen extent and bubble span last told to the pet (edgesKey). */
  sentEdges: string;
  /** The owner the current window was made with. */
  petOwner: PetAppWindow | null;
  /** The app layout last sent to the app window (JSON; '' for none yet). */
  sentAppLayout: string;
  /** The live window is flipped: at the screen's top, its bubble, quick
   *  message and menu open below the bot (windowAt). */
  flipped: boolean;
}

const live = (window: PetWindow | null): window is PetWindow => Boolean(window && !window.isDestroyed());

function save(s: PetContext, next: Partial<DesktopPetPrefs>) {
  s.prefs = { ...s.prefs, ...next };
  s.writePrefs(s.deps.prefsPath, s.prefs);
}

function config(s: PetContext): DesktopPetConfig {
  return {
    enabled: s.prefs.enabled,
    pinned: s.prefs.pinned,
    pinnedHere: s.prefs.pinnedHere,
    onScreen: s.prefs.onScreen,
    keepAbove: s.prefs.keepAbove,
    collapsed: s.prefs.collapsed,
    autoAdvance: s.prefs.autoAdvance,
    autoClose: s.prefs.autoClose,
    scale: s.prefs.scale,
  };
}

/** The window and sprite box at the bot's scale: a live window was made at
 *  this scale (a new scale replaces the window, see setScale). */
function geometry(s: PetContext) {
  return desktopPetGeometry(s.prefs.scale);
}

function windowSize(s: PetContext) {
  return geometry(s).window;
}

/** The app window, while it exists. */
function appWindow(s: PetContext): PetAppWindow | null {
  return s.app && !s.app.isDestroyed() ? s.app : null;
}

/** The app window is on screen (not hidden, not minimised). */
function appShowing(s: PetContext): boolean {
  const owner = appWindow(s);
  return Boolean(owner?.isVisible() && !owner.isMinimized());
}

/** Which layer the pet lives on: following the app window (owned by it:
 *  just above it, covered with it by other apps' windows, minimised with
 *  it), or above every window. Free on screen it is owned by none either:
 *  a window of its own (above every window only with keepAbove). */
function wantedOwner(s: PetContext): PetAppWindow | null {
  return s.prefs.keepAbove || s.prefs.onScreen ? null : appWindow(s);
}

/** The display the pet belongs on now: the app window's, else the primary. */
function homeDisplay(s: PetContext): PetDisplay {
  const owner = appWindow(s);
  return owner ? s.deps.screen.getDisplayMatching(owner.getBounds()) : s.deps.screen.getPrimaryDisplay();
}

function displayFor(s: PetContext, point: { x: number; y: number }): PetDisplay {
  return (
    displayForPetPosition(point, windowSize(s), s.deps.screen.getAllDisplays()) ?? s.deps.screen.getPrimaryDisplay()
  );
}

/** The window's real top-left on screen. */
function windowPosition(s: PetContext): { x: number; y: number } {
  const [x = 0, y = 0] = live(s.pet) ? s.pet.getPosition() : [];
  return { x, y };
}

/** How far below its spot a flipped window stands: its sprite box moves
 *  from the window's bottom (DESKTOP_PET_SPRITE.bottom up) to its top (as
 *  far down), so the bot stays where it was put. */
function flipShift(s: PetContext): number {
  const { sprite, window } = geometry(s);
  return window.height - 2 * sprite.bottom - sprite.size;
}

/** The window's spot: its top-left as laid out unflipped (above the work
 *  area's top while flipped). Spots are saved, dragged and anchored as this;
 *  the sprite box is at the same place on screen either way (spriteBox). */
function currentPosition(s: PetContext): { x: number; y: number } {
  const at = windowPosition(s);
  return s.flipped ? { x: at.x, y: at.y - flipShift(s) } : at;
}

/** The window for `spot`: flipped (its bubble, quick message and menu below
 *  the bot) when the unflipped window's top would be above its work area,
 *  which only a free or pinned-here bot at the screen's top reaches. */
function windowAt(s: PetContext, spot: { x: number; y: number }) {
  const flipped = spot.y < displayFor(s, spot).workArea.y;
  return { flipped, x: spot.x, y: spot.y + (flipped ? flipShift(s) : 0) };
}

function screenRight(s: PetContext): number {
  if (!live(s.pet)) return windowSize(s).width;
  const at = windowPosition(s);
  const area = displayFor(s, at).workArea;
  return Math.max(0, Math.min(windowSize(s).width, area.x + area.width - at.x));
}

/** The span (window px, from its left) the bubble lies in: the app window's
 *  content while the bot stands on it (pinned, or its sprite's centre over
 *  it), else the work area; within the window either way. */
function bubbleSpan(s: PetContext): { left: number; right: number } {
  const { width } = windowSize(s);
  if (!live(s.pet)) return { left: 0, right: width };
  const at = currentPosition(s);
  const area = displayFor(s, at).workArea;
  let left = area.x;
  let right = area.x + area.width;
  const owner = appWindow(s);
  // Free on screen: the bubble keeps to the screen, never to the app window.
  if (owner && appShowing(s) && !s.prefs.onScreen) {
    const content = owner.getContentBounds();
    const box = spriteBox(s, at);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const over = x >= content.x && x < content.x + content.width && y >= content.y && y < content.y + content.height;
    if (locked(s) || over) {
      left = Math.max(left, content.x);
      right = Math.min(right, content.x + content.width);
    }
  }
  const inWindow = (edge: number) => Math.max(0, Math.min(width, edge - at.x));
  return { left: inWindow(left), right: Math.max(inWindow(left), inWindow(right)) };
}

/** The app's open transient layers (menus, popovers, listboxes, tooltips)
 *  over the pet window, in its px (rounded outward, clipped to it): the pet
 *  cuts them out of all it draws, so the app's layer shows through there
 *  and takes the pointer, as if the pet stood behind it. */
function cutouts(s: PetContext): DesktopPetRect[] {
  const owner = appWindow(s);
  if (!owner || !live(s.pet) || !s.layers.length || !appShowing(s)) return [];
  const content = owner.getContentBounds();
  const zoom = owner.webContents.getZoomFactor();
  const at = windowPosition(s);
  const { width, height } = windowSize(s);
  const cuts: DesktopPetRect[] = [];
  for (const layer of s.layers) {
    const left = Math.max(0, Math.floor(content.x + layer.x * zoom - at.x));
    const top = Math.max(0, Math.floor(content.y + layer.y * zoom - at.y));
    const right = Math.min(width, Math.ceil(content.x + (layer.x + layer.width) * zoom - at.x));
    const bottom = Math.min(height, Math.ceil(content.y + (layer.y + layer.height) * zoom - at.y));
    if (right > left && bottom > top) cuts.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return cuts;
}

/** What of the view follows the window's spot and the app's layers (its
 *  on-screen extent, the bubble's span, the cut-outs), to resend only when
 *  it changed. */
function edgesKey(s: PetContext): string {
  const span = bubbleSpan(s);
  return `${s.flipped} ${screenRight(s)} ${span.left} ${span.right} ${JSON.stringify(cutouts(s))}`;
}

function view(s: PetContext): DesktopPetView {
  s.sentEdges = edgesKey(s);
  return {
    ...s.state,
    collapsed: s.prefs.collapsed,
    autoAdvance: s.prefs.autoAdvance,
    autoClose: s.prefs.autoClose,
    keepAbove: s.prefs.keepAbove,
    pinned: s.prefs.pinned,
    pinnedHere: s.prefs.pinnedHere,
    onScreen: s.prefs.onScreen,
    scale: s.prefs.scale,
    flipped: s.flipped,
    theme: s.theme,
    visible: live(s.pet) && s.pet.isVisible(),
    screenRight: screenRight(s),
    bubbleSpan: bubbleSpan(s),
    cutouts: cutouts(s),
  };
}

function pushView(s: PetContext) {
  if (live(s.pet) && !s.pet.webContents.isDestroyed()) s.pet.webContents.send(DESKTOP_PET_IPC.view, view(s));
}

function pushConfig(s: PetContext) {
  const owner = appWindow(s);
  if (owner && !owner.webContents.isDestroyed()) owner.webContents.send(DESKTOP_PET_IPC.config, config(s));
}

/** Put the window at `spot` (currentPosition), flipped at the screen's top
 *  (windowAt). Its size never changes (the menu fits beside the pet):
 *  resizing a transparent window flashes its old frame at the new bounds on
 *  Windows. */
function place(s: PetContext, spot: { x: number; y: number }) {
  if (!live(s.pet)) return;
  const { flipped, x, y } = windowAt(s, spot);
  s.flipped = flipped;
  s.pet.setBounds({ x, y, width: windowSize(s).width, height: windowSize(s).height });
  // Moved on or off a screen or app edge (or flipped): the menu's side, the
  // bubble's span and the layout follow.
  if (edgesKey(s) !== s.sentEdges) pushView(s);
}

/** Move inside the work area of the display the spot belongs to (the bot
 *  itself reaches its side edges: clampFreePetPosition). */
function moveTo(s: PetContext, point: { x: number; y: number }, persist: boolean) {
  if (!live(s.pet)) return;
  const display = displayFor(s, point);
  const next = clampFreePetPosition(point, geometry(s), display.workArea);
  place(s, next);
  if (persist) save(s, { positions: { ...s.prefs.positions, [String(display.id)]: next } });
}

/** The pinned spot on the app window's composer, clamped to its display
 *  (the pet and its quick message stay on screen); null while the app
 *  window is gone, hidden or minimised. */
function pinnedSpot(s: PetContext): { x: number; y: number } | null {
  const owner = appWindow(s);
  if (!owner || !s.composer || !appShowing(s)) return null;
  const shape = geometry(s);
  const target = pinnedPetPosition(owner.getContentBounds(), s.composer, owner.webContents.getZoomFactor(), shape);
  const core = { width: shape.coreWidth, height: shape.window.height };
  return clampPetPosition(target, core, displayFor(s, target).workArea);
}

/** The sprite box (screen px) of a window whose top-left is `point`. */
function spriteBox(s: PetContext, point: { x: number; y: number }): DesktopPetRect {
  const { sprite, window } = geometry(s);
  return {
    x: point.x + sprite.left,
    y: point.y + window.height - sprite.bottom - sprite.size,
    width: sprite.size,
    height: sprite.size,
  };
}

/** "Pin here" against the app window: the anchor for the window at `point`
 *  saved (null without an app window: kept as an absolute spot until one
 *  attaches). */
function anchorHere(s: PetContext, point: { x: number; y: number }) {
  const owner = appWindow(s);
  if (!owner) return;
  const box = composerBox(s, owner);
  const hereAnchor = petHereAnchor(point, spriteBox(s, point), box ?? owner.getContentBounds());
  save(s, { hereAnchor: box ? { ...hereAnchor, composer: true } : hereAnchor });
}

/** The composer card in screen px (the app's content bounds, its CSS px at
 *  the zoom): what a pinned-here spot is held against, so it follows the
 *  card when the side dock or the sidebar moves it. Null without a card. */
function composerBox(s: PetContext, owner: PetAppWindow): DesktopPetRect | null {
  if (!s.composer) return null;
  const content = owner.getContentBounds();
  const zoom = owner.webContents.getZoomFactor();
  return {
    x: content.x + s.composer.x * zoom,
    y: content.y + s.composer.y * zoom,
    width: s.composer.width * zoom,
    height: s.composer.height * zoom,
  };
}

/** The pinned-here spot: its anchor against the app window's content
 *  bounds, the sprite kept inside them and the window on its display; null
 *  while the app window is gone, hidden or minimised. An older absolute
 *  spot becomes an anchor against the window it first meets. */
function hereSpot(s: PetContext): { x: number; y: number } | null {
  const owner = appWindow(s);
  if (!owner || !appShowing(s)) return null;
  if (!s.prefs.hereAnchor)
    anchorHere(s, live(s.pet) ? currentPosition(s) : petPositionOn(homeDisplay(s), s.prefs, geometry(s)));
  const content = owner.getContentBounds();
  // An anchor against the window (an older one, or made before the card
  // showed) moves onto the card as soon as there is one, where it stands.
  const older = s.prefs.hereAnchor;
  if (older && !older.composer && s.composer) anchorHere(s, petHerePosition(older, content));
  const anchor = s.prefs.hereAnchor;
  if (!anchor) return null;
  // Held against the card: none showing, nothing to follow.
  const box = anchor.composer ? composerBox(s, owner) : content;
  if (!box) return null;
  const shape = geometry(s);
  const target = petHerePosition(anchor, box);
  const above = shape.window.height - shape.sprite.bottom - shape.sprite.size;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));
  const inside = {
    x: clamp(
      target.x,
      content.x - shape.sprite.left,
      content.x + content.width - shape.sprite.left - shape.sprite.size
    ),
    y: clamp(target.y, content.y - above, content.y + content.height - (shape.window.height - shape.sprite.bottom)),
  };
  return clampFreePetPosition(inside, shape, displayFor(s, inside).workArea);
}

/** Composer-pinned and on screen, its sprite box over the transcript's
 *  column: beside it horizontally and reaching above the line the column's
 *  last row ends on (a bot resting on the island's baseline in a wide
 *  window stays below it). */
function overTranscript(s: PetContext): boolean {
  const owner = appWindow(s);
  const column = s.composer?.transcript;
  if (!owner || !column || !s.prefs.pinned || !live(s.pet) || !s.pet.isVisible()) return false;
  const content = owner.getContentBounds();
  const zoom = owner.webContents.getZoomFactor();
  const box = spriteBox(s, currentPosition(s));
  const left = content.x + column.left * zoom;
  const right = content.x + column.right * zoom;
  return box.x < right && box.x + box.width > left && box.y < content.y + column.bottom * zoom;
}

/** The width (the app's CSS px) the bot takes at the composer card's right
 *  end — its visible art (from the look's leftmost drawn column to the
 *  sprite box's right edge; the whole box for a room's stack or a picture)
 *  at this scale and zoom, the pin inset and the island's clearance — while
 *  the overlay is on and pinned above the
 *  message box; else 0. Only the setting decides, never whether the window
 *  shows at this moment (stepping aside from a menu, minimised with the app
 *  where the island is not seen either, a window replaced for a new size)
 *  nor where the island lifts it: the island's compact switch moves with
 *  the setting, the scale and the zoom, never with its own width. */
function islandReserve(s: PetContext): number {
  const owner = appWindow(s);
  if (!owner || !s.prefs.enabled || !s.available || !s.prefs.pinned || !s.composer) return 0;
  const zoom = owner.webContents.getZoomFactor();
  const { size } = geometry(s).sprite;
  const columns = petMascotCells(s.state.face).map((cell) => cell.x);
  const art = columns.length ? size - (Math.min(...columns) * size) / 16 : size;
  return Math.ceil((art + DESKTOP_PET_PIN_INSET) / zoom) + DESKTOP_PET_ISLAND_CLEARANCE;
}

/** The layout around the bot to the app window, only when it changes. */
function pushAppLayout(s: PetContext) {
  const owner = appWindow(s);
  if (!owner || owner.webContents.isDestroyed()) return;
  const next: DesktopPetAppLayout = { overTranscript: overTranscript(s), islandReserve: islandReserve(s) };
  const key = JSON.stringify(next);
  if (key === s.sentAppLayout) return;
  s.sentAppLayout = key;
  owner.webContents.send(DESKTOP_PET_IPC.appLayout, next);
}

/** A modal with the app's backdrop is open and what the pet draws overlaps
 *  the app window: the pet hides, as under the dim (a separate window would
 *  cover it). Transient layers only cut it (cutouts). */
function occluded(s: PetContext): boolean {
  const owner = appWindow(s);
  if (!owner || !live(s.pet) || !s.area || !s.backdrop || !appShowing(s)) return false;
  const [wx = 0, wy = 0] = s.pet.getPosition();
  const x = wx + s.area.x;
  const y = wy + s.area.y;
  const content = owner.getContentBounds();
  return (
    content.x < x + s.area.width &&
    content.x + content.width > x &&
    content.y < y + s.area.height &&
    content.y + content.height > y
  );
}

/** Pinned: stand on the composer. Shown only together with the app's
 *  composer (none yet while the app boots, none on a settings page,
 *  onboarding or a reload) — pinned already at its spot from the first
 *  frame; following the app window, only while that window is on screen;
 *  and never over the app's backdrop modals (its menus and popovers cut it). */
function layout(s: PetContext) {
  if (!live(s.pet)) {
    pushAppLayout(s);
    return;
  }
  const spot = s.prefs.pinned ? pinnedSpot(s) : s.prefs.pinnedHere ? hereSpot(s) : null;
  if (spot) place(s, spot);
  const show =
    s.loaded &&
    s.painted &&
    s.published &&
    // Free on screen: shown apart from the app window (minimised, hidden or
    // on a page with no composer).
    (s.prefs.onScreen || s.composer !== null) &&
    (locked(s) ? Boolean(spot) : s.prefs.keepAbove || s.prefs.onScreen || appShowing(s)) &&
    !occluded(s);
  if (show !== s.pet.isVisible()) {
    if (show) s.pet.showInactive();
    else s.pet.hide();
    // The pet pauses its idle animation while off screen.
    pushView(s);
  } else if (edgesKey(s) !== s.sentEdges) {
    // The app window moved under a free pet, or its layers changed: the
    // bubble's span and the cut-outs follow.
    pushView(s);
  }
  pushAppLayout(s);
}

/** A display went away or changed: keep the pet on a live work area, on
 *  the primary display when its own is gone. */
function onDisplaysChanged(s: PetContext) {
  if (!live(s.pet)) return;
  if (locked(s)) {
    layout(s);
    return;
  }
  const point = currentPosition(s);
  const cx = point.x + windowSize(s).width / 2;
  const cy = point.y + windowSize(s).height / 2;
  const onScreen = s.deps.screen
    .getAllDisplays()
    .some(({ workArea: a }) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  if (onScreen) {
    moveTo(s, point, false);
    return;
  }
  place(s, petPositionOn(s.deps.screen.getPrimaryDisplay(), s.prefs, geometry(s)));
}

/** Pinned (above the message box or here): it cannot be moved by hand. */
function locked(s: PetContext): boolean {
  return s.prefs.pinned || s.prefs.pinnedHere;
}

/** A pinned pet does not move: unpin it first (menu or Settings). */
function dragPet(s: PetContext, input: DesktopPetDrag) {
  if (locked(s)) {
    s.drag = null;
    return;
  }
  if (input.phase === 'start') {
    s.drag = { ...currentPosition(s), screenX: input.screenX, screenY: input.screenY };
    return;
  }
  if (!s.drag) return;
  const point = { x: s.drag.x + input.screenX - s.drag.screenX, y: s.drag.y + input.screenY - s.drag.screenY };
  moveTo(s, point, input.phase === 'end');
  if (input.phase === 'end') s.drag = null;
}

/** A live window on the wrong layer is replaced, never re-layered in place. */
function applyLayer(s: PetContext) {
  if (!live(s.pet) || s.petOwner === wantedOwner(s)) return;
  destroyPetWindow(s);
  syncPetWindow(s);
}

/** A preference changed from the menu or Settings: both show it. */
function changed(s: PetContext): DesktopPetConfig {
  pushView(s);
  pushConfig(s);
  return config(s);
}

function setKeepAbove(s: PetContext, on: boolean) {
  if (s.prefs.keepAbove !== on) save(s, { keepAbove: on });
  applyLayer(s);
  layout(s);
  return changed(s);
}

function setCollapsed(s: PetContext, on: boolean) {
  if (s.prefs.collapsed !== on) save(s, { collapsed: on });
  return changed(s);
}

/** Pinned: stands on the message box and cannot be moved. Unpinned: where
 *  it stands now becomes its free spot, and it can be dragged. */
function setPinned(s: PetContext, on: boolean) {
  if (s.prefs.pinned !== on) save(s, { pinned: on });
  if (on && s.prefs.pinnedHere) save(s, { pinnedHere: false });
  if (on && s.prefs.onScreen) {
    save(s, { onScreen: false });
    applyLayer(s);
  }
  s.drag = null;
  if (on) layout(s);
  else {
    moveTo(s, currentPosition(s), true);
    layout(s);
  }
  return changed(s);
}

/** The bot's size. The window keeps one size while it lives (resizing a
 *  transparent window flashes its old frame), so a new scale replaces it
 *  with one made for that scale; a free bot keeps its feet where they stood
 *  (the sprite stands at the window's bottom-left part, the window grows up
 *  and right). */
function setScale(s: PetContext, scale: number): DesktopPetConfig {
  if (s.prefs.scale === scale) return config(s);
  const before = windowSize(s);
  const at = currentPosition(s);
  const wasLive = live(s.pet);
  save(s, { scale });
  if (wasLive) {
    if (!s.prefs.pinned) {
      const display = displayFor(s, at);
      const spot = clampFreePetPosition(
        { x: at.x, y: at.y + before.height - windowSize(s).height },
        geometry(s),
        display.workArea
      );
      save(s, { positions: { ...s.prefs.positions, [String(display.id)]: spot } });
      // Pinned here: the same feet, against the app window.
      if (s.prefs.pinnedHere) anchorHere(s, spot);
    }
    destroyPetWindow(s);
    syncPetWindow(s);
  }
  return changed(s);
}

/** "Pin here": locked where it stands now, against the app window (its
 *  distance from the nearest corner of the window's content kept as the
 *  window moves or resizes, and across restarts); turns "Pin above the
 *  message box" off. Off: free and draggable again, where it stands. */
function setPinnedHere(s: PetContext, on: boolean) {
  if (on && s.prefs.pinned) setPinned(s, false);
  if (on && s.prefs.onScreen) {
    save(s, { onScreen: false });
    applyLayer(s);
  }
  if (s.prefs.pinnedHere !== on) save(s, { pinnedHere: on });
  s.drag = null;
  if (on) {
    moveTo(s, currentPosition(s), true);
    if (live(s.pet)) anchorHere(s, currentPosition(s));
  } else {
    if (s.prefs.hereAnchor) save(s, { hereAnchor: null });
    if (live(s.pet)) moveTo(s, currentPosition(s), true);
  }
  layout(s);
  return changed(s);
}

/** "Free on screen": free and draggable anywhere on its displays, apart
 *  from the app window: a window of its own (owned by none), never clamped
 *  to, moved with or hidden with the app window, its bubble kept to the
 *  screen; turns both pins off. "Keep above other windows" stays its own
 *  choice (the layer only). Off: free as before, following the app window. */
function setOnScreen(s: PetContext, on: boolean) {
  if (on && s.prefs.pinned) setPinned(s, false);
  if (on && s.prefs.pinnedHere) setPinnedHere(s, false);
  if (s.prefs.onScreen !== on) save(s, { onScreen: on });
  s.drag = null;
  applyLayer(s);
  if (live(s.pet)) moveTo(s, currentPosition(s), true);
  layout(s);
  return changed(s);
}

/** One option by name (the app window's Settings). */
function setOption(s: PetContext, rawName: unknown, rawValue: unknown): DesktopPetConfig {
  const { name, value } = requiredDesktopPetOption(rawName, rawValue);
  if (name === 'pinned') return setPinned(s, value);
  if (name === 'pinnedHere') return setPinnedHere(s, value);
  if (name === 'onScreen') return setOnScreen(s, value);
  if (name === 'keepAbove') return setKeepAbove(s, value);
  if (name === 'collapsed') return setCollapsed(s, value);
  // Reply reading only: the pet window draws it from the view.
  if (s.prefs[name] !== value) save(s, { [name]: value });
  return changed(s);
}

/** Back above the message box: re-pinned, this display's free spot forgotten. */
function reset(s: PetContext): DesktopPetConfig {
  if (live(s.pet)) {
    const display =
      displayForPetPosition(currentPosition(s), windowSize(s), s.deps.screen.getAllDisplays()) ?? homeDisplay(s);
    const positions = { ...s.prefs.positions };
    delete positions[String(display.id)];
    save(s, { positions });
  }
  if (!s.prefs.pinned || s.prefs.pinnedHere || s.prefs.hereAnchor || s.prefs.onScreen) {
    save(s, { pinned: true, pinnedHere: false, hereAnchor: null, onScreen: false });
  }
  s.drag = null;
  applyLayer(s);
  layout(s);
  return changed(s);
}

function setEnabled(s: PetContext, on: boolean): DesktopPetConfig {
  if (s.prefs.enabled !== on) save(s, { enabled: on });
  syncPetWindow(s);
  pushConfig(s);
  return config(s);
}

/** The pet's own menu (drawn in its window). */
function runCommand(s: PetContext, command: DesktopPetCommand) {
  switch (command) {
    case 'open':
      s.deps.openApp(s.state.sessionId);
      return;
    case 'settings': {
      // The app window to front, on Settings → Bots (the overlay's options).
      s.deps.openApp('');
      const owner = appWindow(s);
      if (owner && !owner.webContents.isDestroyed()) owner.webContents.send(DESKTOP_PET_IPC.openSettings);
      return;
    }
    case 'pin-here':
      setPinnedHere(s, !s.prefs.pinnedHere);
      return;
    case 'on-screen':
      setOnScreen(s, !s.prefs.onScreen);
      return;
    case 'collapse':
      setCollapsed(s, !s.prefs.collapsed);
      return;
    case 'keep-above':
      setKeepAbove(s, !s.prefs.keepAbove);
      return;
    case 'pin':
      setPinned(s, !s.prefs.pinned);
      return;
    case 'reset':
      reset(s);
      return;
    case 'off':
      setEnabled(s, false);
      return;
  }
}

/** The pet window's own channels, each validated before use. */
function listenPetWindow(s: PetContext, window: PetWindow) {
  const { ipc } = window.webContents;
  const guard =
    (run: (...args: unknown[]) => void): Listener =>
    (_event, ...args) => {
      try {
        run(...args);
      } catch {
        // A malformed message from the pet window is dropped.
      }
    };
  ipc.on(
    DESKTOP_PET_IPC.ready,
    guard(() => pushView(s))
  );
  // Shown only once the pet has drawn its first frame: a transparent window
  // shown before then flashes an empty box on Windows.
  ipc.on(
    DESKTOP_PET_IPC.painted,
    guard(() => {
      if (s.painted) return;
      s.painted = true;
      if (s.loaded) layout(s);
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.open,
    guard(() => s.deps.openApp(s.state.sessionId))
  );
  // Only the reply the followed chat shows now: a late message for an
  // older one marks nothing.
  ipc.on(
    DESKTOP_PET_IPC.read,
    guard((key) => {
      const { bubble, sessionId } = s.state;
      if (sessionId && bubble.kind === 'reply' && bubble.key === key) s.deps.markRead(sessionId);
    })
  );
  // The whole shown reply (every page), from main's own copy of it.
  ipc.on(
    DESKTOP_PET_IPC.copy,
    guard((key) => {
      const { bubble } = s.state;
      if (bubble.kind === 'reply' && bubble.key === key) s.deps.copyText(bubble.text);
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.command,
    guard((value) => runCommand(s, requiredDesktopPetCommand(value)))
  );
  ipc.on(
    DESKTOP_PET_IPC.area,
    guard((value) => {
      s.area = requiredDesktopPetComposerRect(value);
      layout(s);
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.drag,
    guard((value) => dragPet(s, requiredDesktopPetDrag(value)))
  );
  ipc.on(
    DESKTOP_PET_IPC.nudge,
    guard((dx, dy) => {
      const delta = requiredDesktopPetNudge(dx, dy);
      if (locked(s)) return;
      const point = currentPosition(s);
      moveTo(s, { x: point.x + delta.dx, y: point.y + delta.dy }, true);
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.reset,
    guard(() => reset(s))
  );
  ipc.on(
    DESKTOP_PET_IPC.scale,
    guard((scale) => setScale(s, requiredDesktopPetScale(scale)))
  );
  ipc.on(
    DESKTOP_PET_IPC.interactive,
    guard((on) => {
      if (live(s.pet)) s.pet.setIgnoreMouseEvents(on !== true, { forward: true });
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.focusInput,
    guard((open) => {
      if (!live(s.pet)) return;
      // The window stays activatable for its whole life (it is shown
      // inactive, so a show never takes focus): toggling setFocusable at
      // runtime left Chromium's IME without the window's text field, so a
      // Korean syllable composed in a detached IME window and appeared only
      // once committed. Closed again: focus goes back to the window below.
      if (open !== true) {
        if (s.pet.isFocused()) s.pet.blur();
        return;
      }
      s.pet.focus();
    })
  );
  // Only a picture the pet shows now: the published face's custom look.
  ipc.handle(DESKTOP_PET_IPC.avatarImage, async (_event, agentId) => {
    const member = s.state.face.members.find((entry) => entry.id === agentId);
    if (!member || (member.avatar as { kind?: unknown } | null)?.kind !== 'custom') return null;
    return (await s.deps.avatarImage?.(member.id)) ?? null;
  });
  ipc.handle(DESKTOP_PET_IPC.send, async (_event, text) => {
    const message = requiredDesktopPetText(text);
    if (!s.state.sessionId) return false;
    return (await s.deps.submit(s.state.sessionId, message)) === true;
  });
}

async function createPetWindow(s: PetContext) {
  if (live(s.pet) || s.disposed) return;
  const at =
    (s.prefs.pinned ? pinnedSpot(s) : s.prefs.pinnedHere ? hereSpot(s) : null) ??
    petPositionOn(homeDisplay(s), s.prefs, geometry(s));
  s.petOwner = wantedOwner(s);
  const { flipped, x, y } = windowAt(s, at);
  s.flipped = flipped;
  const window = s.deps.createWindow(
    { x, y, ...windowSize(s) },
    { parent: s.petOwner, alwaysOnTop: s.prefs.keepAbove }
  );
  s.pet = window;
  s.loaded = false;
  s.painted = false;
  listenPetWindow(s, window);
  // Losing focus to the user's click closes the quick message; losing it
  // because the window hides (an app modal's backdrop, minimised with the
  // app) keeps it for when the pet comes back.
  window.on('blur', () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.isVisible()) {
      window.webContents.send(DESKTOP_PET_IPC.blurred);
    }
  });
  window.on('closed', () => {
    if (s.pet === window) s.pet = null;
  });
  try {
    await s.deps.load(window);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    if (s.pet === window) s.pet = null;
    throw error;
  }
  if (window.isDestroyed() || s.pet !== window) return;
  // Empty pixels pass clicks through; the renderer claims the pointer over
  // the pet, its bubble and the quick message from the mouse moves Electron
  // forwards. Only once the page is loaded: on Windows the forwarding posts
  // to the page's child window, which Electron picks up when the page
  // creates it; armed before that (the window is hidden until it has drawn
  // anyway), it forwards to no window, no move ever reaches the pet, and the
  // whole overlay stays click-through (a click or right-click on the bot
  // lands on the app below).
  window.setIgnoreMouseEvents(true, { forward: true });
  s.loaded = true;
  layout(s);
}

function destroyPetWindow(s: PetContext) {
  const window = s.pet;
  s.pet = null;
  s.flipped = false;
  s.loaded = false;
  s.painted = false;
  s.drag = null;
  if (window && !window.isDestroyed()) window.destroy();
  pushAppLayout(s);
}

/** The window exists while the setting is on and the representative bot does. */
function syncPetWindow(s: PetContext) {
  // Following the app window needs one to belong to.
  if (s.started && s.prefs.enabled && s.available && (s.prefs.keepAbove || s.prefs.onScreen || appWindow(s))) {
    void createPetWindow(s).catch(() => {});
  } else {
    destroyPetWindow(s);
  }
}

/** The app window's channels: its chat state, composer, theme and layers in;
 *  the setting out. Returns the undo. */
function listenAppWindow(s: PetContext, window: PetAppWindow): () => void {
  // Held here: a closed BrowserWindow throws "Object has been destroyed" on
  // its `webContents` getter, and the undo runs from its 'closed' event.
  const contents = window.webContents;
  const { ipc } = contents;
  // A reload (or a crashed renderer) takes the composer with it: the pet
  // waits for the new page's first composer.
  const onReload = () => {
    s.composer = null;
    s.published = false;
    s.layers = [];
    s.backdrop = false;
    // The new page holds no layout: the next one goes out again.
    s.sentAppLayout = '';
    layout(s);
  };
  contents.on('did-navigate', onReload);
  contents.on('render-process-gone', onReload);
  const publish = applyValid(requiredDesktopPetState, (next) => {
    s.state = next;
    pushView(s);
    // Another look: another art width for the island to clear.
    pushAppLayout(s);
    if (s.published) return;
    s.published = true;
    layout(s);
  });
  const onComposer = applyValid(requiredDesktopPetComposer, (next) => {
    s.composer = next;
    layout(s);
  });
  const onTheme = applyValid(requiredDesktopPetTheme, (next) => {
    s.theme = next;
    pushView(s);
  });
  const onLayers = applyValid(requiredDesktopPetLayers, (next) => {
    s.layers = next.rects;
    s.backdrop = next.backdrop;
    layout(s);
  });
  const onAvailable: Listener = (_event, value) => {
    if (typeof value !== 'boolean' || s.available === value) return;
    s.available = value;
    syncPetWindow(s);
  };
  ipc.on(DESKTOP_PET_IPC.publish, publish);
  ipc.on(DESKTOP_PET_IPC.composer, onComposer);
  ipc.on(DESKTOP_PET_IPC.theme, onTheme);
  ipc.on(DESKTOP_PET_IPC.layers, onLayers);
  ipc.on(DESKTOP_PET_IPC.available, onAvailable);
  ipc.handle(DESKTOP_PET_IPC.getConfig, () => config(s));
  ipc.handle(DESKTOP_PET_IPC.setEnabled, (_event, on) => {
    if (typeof on !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return setEnabled(s, on);
  });
  ipc.handle(DESKTOP_PET_IPC.setOption, (_event, name, value) => setOption(s, name, value));
  ipc.handle(DESKTOP_PET_IPC.setScale, (_event, scale) => setScale(s, requiredDesktopPetScale(scale)));
  ipc.handle(DESKTOP_PET_IPC.resetPosition, () => reset(s));
  return () => {
    if (contents.isDestroyed()) return;
    contents.removeListener('did-navigate', onReload);
    contents.removeListener('render-process-gone', onReload);
    ipc.removeListener(DESKTOP_PET_IPC.publish, publish);
    ipc.removeListener(DESKTOP_PET_IPC.composer, onComposer);
    ipc.removeListener(DESKTOP_PET_IPC.theme, onTheme);
    ipc.removeListener(DESKTOP_PET_IPC.layers, onLayers);
    ipc.removeListener(DESKTOP_PET_IPC.available, onAvailable);
    ipc.removeHandler(DESKTOP_PET_IPC.getConfig);
    ipc.removeHandler(DESKTOP_PET_IPC.setEnabled);
    ipc.removeHandler(DESKTOP_PET_IPC.setOption);
    ipc.removeHandler(DESKTOP_PET_IPC.setScale);
    ipc.removeHandler(DESKTOP_PET_IPC.resetPosition);
  };
}

function attachAppWindow(s: PetContext, window: PetAppWindow) {
  s.detachApp?.();
  s.app = window;
  s.composer = null;
  s.published = false;
  s.sentAppLayout = '';
  const stopListening = listenAppWindow(s, window);
  // The pet follows the window: moved, resized, minimised, hidden.
  const relayout = () => layout(s);
  for (const event of APP_WINDOW_EVENTS) window.on(event, relayout);
  const detach = () => {
    if (s.detachApp !== detach) return;
    s.detachApp = null;
    if (s.app === window) {
      s.app = null;
      s.composer = null;
      s.layers = [];
      s.backdrop = false;
    }
    for (const event of APP_WINDOW_EVENTS) window.removeListener(event, relayout);
    window.removeListener('closed', detach);
    stopListening();
    applyLayer(s);
    layout(s);
  };
  s.detachApp = detach;
  window.on('closed', detach);
  // An owned pet goes with a closed owner: a new app window brings it back.
  syncPetWindow(s);
  applyLayer(s);
  layout(s);
}

export function createDesktopPet(deps: DesktopPetDeps) {
  const readPrefs = deps.readPrefs ?? readDesktopPetPrefs;
  const s: PetContext = {
    deps,
    writePrefs: deps.writePrefs ?? writeDesktopPetPrefs,
    prefs: readPrefs(deps.prefsPath),
    state: IDLE_STATE,
    pet: null,
    app: null,
    detachApp: null,
    disposed: false,
    started: false,
    available: false,
    loaded: false,
    painted: false,
    composer: null,
    published: false,
    theme: null,
    layers: [],
    backdrop: false,
    area: null,
    drag: null,
    sentEdges: '',
    petOwner: null,
    sentAppLayout: '',
    flipped: false,
  };

  const onScreenChange = () => onDisplaysChanged(s);
  deps.screen.on('display-removed', onScreenChange);
  deps.screen.on('display-metrics-changed', onScreenChange);

  return {
    /** App ready: the window opens once the setting is on and the
     *  representative bot exists. */
    start() {
      s.started = true;
      syncPetWindow(s);
    },
    /** Whether the representative bot exists (tests; the app window reports it). */
    setAvailable(on: boolean) {
      if (s.available === on) return;
      s.available = on;
      syncPetWindow(s);
    },
    config: () => config(s),
    setEnabled: (on: boolean) => setEnabled(s, on),
    setOption: (name: unknown, value: unknown) => setOption(s, name, value),
    setScale: (scale: unknown) => setScale(s, requiredDesktopPetScale(scale)),
    /** The overlay shows `sessionId`'s replies right now (its window on
     *  screen, its bubble not collapsed, following that session): the OS
     *  "turn finished" notice for it is redundant. */
    showsSession: (sessionId: string) =>
      Boolean(sessionId) && live(s.pet) && s.pet.isVisible() && !s.prefs.collapsed && s.state.sessionId === sessionId,
    /** The pet's current window (tests, the live check). */
    window: () => (live(s.pet) ? s.pet : null),
    /** This app window publishes Mixy's chat and reads/writes the setting. */
    attachAppWindow: (window: PetAppWindow) => attachAppWindow(s, window),
    /** Quit: the window goes, the listeners go. */
    dispose() {
      s.disposed = true;
      s.detachApp?.();
      deps.screen.removeListener('display-removed', onScreenChange);
      deps.screen.removeListener('display-metrics-changed', onScreenChange);
      destroyPetWindow(s);
    },
  };
}

export type DesktopPet = ReturnType<typeof createDesktopPet>;
