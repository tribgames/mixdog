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
import type { ToolApprovalDecision } from '../shared/contract';
import { DESKTOP_PET_WINDOW_IPC } from '../shared/desktop-pet-bridge';
import {
  DESKTOP_PET_IPC as DESKTOP_PET_APP_IPC,
  DESKTOP_PET_ISLAND_CLEARANCE,
  type DesktopPetAppLayout,
  type DesktopPetCommand,
  type DesktopPetComposer,
  type DesktopPetConfig,
  type DesktopPetDrag,
  type DesktopPetGeometry,
  type DesktopPetRect,
  type DesktopPetState,
  type DesktopPetTheme,
  type DesktopPetView,
} from '../shared/desktop-pet';
import { petMascotCells } from '../shared/desktop-pet-art';
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

type Point = { x: number; y: number };

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

/** Where a pinned-here window stands against the app window (the core's
 *  document: see PetHereAnchor in desktopPet/state/read). */
export interface PetHereAnchor {
  right: boolean;
  bottom: boolean;
  dx: number;
  dy: number;
  composer?: true;
}

/** The pet's per-device settings, as the core stores and answers them
 *  (desktopPet/state/read): main only holds them and asks the core to store a
 *  change. */
export interface DesktopPetPrefs {
  enabled: boolean;
  keepAbove: boolean;
  collapsed: boolean;
  autoAdvance: boolean;
  autoClose: boolean;
  pinned: boolean;
  pinnedHere: boolean;
  onScreen: boolean;
  scale: number;
  positions: Record<string, Point>;
  hereAnchor: PetHereAnchor | null;
}

/** How far inside the composer card's right edge the pinned sprite box's
 *  right edge sits (the core's PIN_INSET): the island's reserve counts it. */
const DESKTOP_PET_PIN_INSET = 2;

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
  screen: PetScreen;
  /** One request to the core (the local connection's `call`): the pet's
   *  settings (`desktopPet/state/*`) and every placement rule
   *  (`desktopPet/placement/resolve`) are the core's. */
  call(method: string, params: unknown): Promise<unknown>;
  /** A request to the core that failed (the overlay carries on without
   *  what it could not get or store). */
  reportError?(what: string, error: unknown): void;
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
  /** Answer a pending approval of `sessionId` the way the approval card does. */
  decideApproval(sessionId: string, id: string, decision: ToolApprovalDecision): Promise<boolean>;
  /** The system clipboard (the pet window has no clipboard permission). */
  copyText(text: string): void;
  /** An agent's custom picture (getAgentAvatarImage: data URLs by state),
   *  for the pet window, which has no capability bridge of its own. */
  avatarImage?(agentId: string): Promise<unknown>;
}

const DESKTOP_PET_IPC = { ...DESKTOP_PET_APP_IPC, ...DESKTOP_PET_WINDOW_IPC };
const IDLE_STATE: DesktopPetState = {
  sessionId: '',
  bubble: { kind: 'idle' },
  face: { room: false, members: [] },
  quiet: false,
};

/** What the overlay holds until the core has answered the first read: off, so
 *  nothing shows. The core's document replaces it whole. */
const PREFS_UNREAD: DesktopPetPrefs = {
  enabled: false,
  keepAbove: false,
  collapsed: false,
  autoAdvance: true,
  autoClose: true,
  pinned: true,
  pinnedHere: false,
  onScreen: false,
  scale: 100,
  positions: {},
  hereAnchor: null,
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
  prefs: DesktopPetPrefs;
  /** The window and sprite at the bot's scale (the core's answer); null until read. */
  shape: DesktopPetGeometry | null;
  /** The last step of the queue every change of the overlay runs through, one at a time. */
  tail: Promise<unknown>;
  /** The last settings write: they reach the core in the order they were made. */
  writing: Promise<unknown>;
  /** A layout step waits in the queue (a burst of window moves asks for one). */
  layoutQueued: boolean;
  /** The newest drag move not yet applied (moves arrive faster than placements resolve). */
  dragMove: DesktopPetDrag | null;
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

// ---- The queue and the core ---------------------------------------------------

function fail(s: PetContext, what: string, error: unknown) {
  s.deps.reportError?.(what, error);
}

/** `run` after every step queued before it has finished: a step reads and
 *  changes the overlay across its core calls, so two never overlap. */
function enqueue<T>(s: PetContext, run: () => Promise<T> | T): Promise<T> {
  const result = s.tail.then(run, run);
  s.tail = result.catch(() => undefined);
  return result;
}

/** A step nobody waits for: a failure is reported, never thrown. */
function later(s: PetContext, run: () => Promise<unknown> | unknown) {
  void enqueue(s, run).catch((error: unknown) => fail(s, 'desktop pet', error));
}

/** A layout pass, once for any number of asks made before it runs. */
function relayout(s: PetContext) {
  if (s.layoutQueued) return;
  s.layoutQueued = true;
  later(s, async () => {
    s.layoutQueued = false;
    await layout(s);
  });
}

async function resolve(s: PetContext, params: Record<string, unknown>): Promise<unknown> {
  return s.deps.call('desktopPet/placement/resolve', params);
}

async function resolvePoint(s: PetContext, params: Record<string, unknown>): Promise<Point> {
  const answer = (await resolve(s, params)) as Partial<Point> | null;
  if (!answer || !Number.isFinite(answer.x) || !Number.isFinite(answer.y)) {
    throw new Error('desktopPet/placement/resolve answered no point');
  }
  return { x: answer.x as number, y: answer.y as number };
}

async function loadPrefs(s: PetContext) {
  try {
    s.prefs = (await s.deps.call('desktopPet/state/read', {})) as DesktopPetPrefs;
    await loadShape(s);
  } catch (error) {
    fail(s, 'desktopPet/state/read', error);
  }
}

async function loadShape(s: PetContext) {
  s.shape = (await resolve(s, { op: 'geometry', scale: s.prefs.scale })) as DesktopPetGeometry;
}

function save(s: PetContext, next: Partial<DesktopPetPrefs>) {
  s.prefs = { ...s.prefs, ...next };
  const prefs = s.prefs;
  s.writing = s.writing
    .then(() => s.deps.call('desktopPet/state/write', { prefs }))
    .then(undefined, (error: unknown) => fail(s, 'desktopPet/state/write', error));
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
function geometry(s: PetContext): DesktopPetGeometry {
  if (!s.shape) throw new Error('the desktop pet has no geometry: the core has not answered');
  return s.shape;
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

const placementDisplay = (display: PetDisplay) => ({ id: display.id, workArea: display.workArea });

async function displayFor(s: PetContext, point: Point): Promise<PetDisplay> {
  const displays = s.deps.screen.getAllDisplays();
  const id = await resolve(s, {
    op: 'displayFor',
    point,
    size: windowSize(s),
    displays: displays.map(placementDisplay),
  });
  return displays.find((display) => display.id === id) ?? s.deps.screen.getPrimaryDisplay();
}

/** A free window's spot on `workArea`: the whole bot inside it. */
function clampFree(s: PetContext, point: Point, workArea: PetRect): Promise<Point> {
  return resolvePoint(s, { op: 'clampFree', point, scale: s.prefs.scale, workArea });
}

/** Where the window opens on `display`: its saved spot there, else the default corner. */
function positionOn(s: PetContext, display: PetDisplay): Promise<Point> {
  return resolvePoint(s, { op: 'positionOn', display: placementDisplay(display), prefs: s.prefs, scale: s.prefs.scale });
}

/** The window's real top-left on screen. */
function windowPosition(s: PetContext): Point {
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
function currentPosition(s: PetContext): Point {
  const at = windowPosition(s);
  return s.flipped ? { x: at.x, y: at.y - flipShift(s) } : at;
}

/** The window for `spot`: flipped (its bubble, quick message and menu below
 *  the bot) when the unflipped window's top would be above its work area,
 *  which only a free or pinned-here bot at the screen's top reaches. */
async function windowAt(s: PetContext, spot: Point) {
  const flipped = spot.y < (await displayFor(s, spot)).workArea.y;
  return { flipped, x: spot.x, y: spot.y + (flipped ? flipShift(s) : 0) };
}

async function screenRight(s: PetContext): Promise<number> {
  if (!live(s.pet)) return windowSize(s).width;
  const at = windowPosition(s);
  const area = (await displayFor(s, at)).workArea;
  return Math.max(0, Math.min(windowSize(s).width, area.x + area.width - at.x));
}

/** The span (window px, from its left) the bubble lies in: the app window's
 *  content while the bot stands on it (pinned, or its sprite's centre over
 *  it), else the work area; within the window either way. */
async function bubbleSpan(s: PetContext): Promise<{ left: number; right: number }> {
  const { width } = windowSize(s);
  if (!live(s.pet)) return { left: 0, right: width };
  const at = currentPosition(s);
  const area = (await displayFor(s, at)).workArea;
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
async function edges(s: PetContext) {
  const right = await screenRight(s);
  const span = await bubbleSpan(s);
  const cuts = cutouts(s);
  return { right, span, cuts, key: `${s.flipped} ${right} ${span.left} ${span.right} ${JSON.stringify(cuts)}` };
}

async function view(s: PetContext): Promise<DesktopPetView> {
  const extent = await edges(s);
  s.sentEdges = extent.key;
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
    screenRight: extent.right,
    bubbleSpan: extent.span,
    cutouts: extent.cuts,
  };
}

async function pushView(s: PetContext) {
  if (!live(s.pet) || s.pet.webContents.isDestroyed()) return;
  const next = await view(s);
  if (live(s.pet) && !s.pet.webContents.isDestroyed()) s.pet.webContents.send(DESKTOP_PET_IPC.view, next);
}

function pushConfig(s: PetContext) {
  const owner = appWindow(s);
  if (owner && !owner.webContents.isDestroyed()) owner.webContents.send(DESKTOP_PET_IPC.config, config(s));
}

/** Put the window at `spot` (currentPosition), flipped at the screen's top
 *  (windowAt). Its size never changes (the menu fits beside the pet):
 *  resizing a transparent window flashes its old frame at the new bounds on
 *  Windows. */
async function place(s: PetContext, spot: Point) {
  if (!live(s.pet)) return;
  const { flipped, x, y } = await windowAt(s, spot);
  if (!live(s.pet)) return;
  s.flipped = flipped;
  s.pet.setBounds({ x, y, width: windowSize(s).width, height: windowSize(s).height });
  // Moved on or off a screen or app edge (or flipped): the menu's side, the
  // bubble's span and the layout follow.
  if ((await edges(s)).key !== s.sentEdges) await pushView(s);
}

/** Move inside the work area of the display the spot belongs to (the bot
 *  itself reaches its side edges: the core's clampFree). */
async function moveTo(s: PetContext, point: Point, persist: boolean) {
  if (!live(s.pet)) return;
  const display = await displayFor(s, point);
  const next = await clampFree(s, point, display.workArea);
  await place(s, next);
  if (persist) save(s, { positions: { ...s.prefs.positions, [String(display.id)]: next } });
}

const placementComposer = (composer: DesktopPetComposer) => ({
  rect: { x: composer.x, y: composer.y, width: composer.width, height: composer.height },
  island: composer.island,
  islandSpan: composer.islandSpan,
});

/** The pinned spot on the app window's composer, clamped to its display
 *  (the pet and its quick message stay on screen); null while the app
 *  window is gone, hidden or minimised. */
async function pinnedSpot(s: PetContext): Promise<Point | null> {
  const owner = appWindow(s);
  if (!owner || !s.composer || !appShowing(s)) return null;
  const shape = geometry(s);
  const target = await resolvePoint(s, {
    op: 'pinned',
    content: owner.getContentBounds(),
    composer: placementComposer(s.composer),
    zoom: owner.webContents.getZoomFactor(),
    scale: s.prefs.scale,
  });
  const core = { width: shape.coreWidth, height: shape.window.height };
  return resolvePoint(s, {
    op: 'clamp',
    point: target,
    size: core,
    workArea: (await displayFor(s, target)).workArea,
  });
}

/** The sprite box (screen px) of a window whose top-left is `point`. */
function spriteBox(s: PetContext, point: Point): DesktopPetRect {
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
async function anchorHere(s: PetContext, point: Point) {
  const owner = appWindow(s);
  if (!owner) return;
  const box = composerBox(s, owner);
  const hereAnchor = (await resolve(s, {
    op: 'hereAnchor',
    point,
    sprite: spriteBox(s, point),
    content: box ?? owner.getContentBounds(),
  })) as PetHereAnchor;
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
async function hereSpot(s: PetContext): Promise<Point | null> {
  const owner = appWindow(s);
  if (!owner || !appShowing(s)) return null;
  if (!s.prefs.hereAnchor) {
    await anchorHere(s, live(s.pet) ? currentPosition(s) : await positionOn(s, homeDisplay(s)));
  }
  const content = owner.getContentBounds();
  // An anchor against the window (an older one, or made before the card
  // showed) moves onto the card as soon as there is one, where it stands.
  const older = s.prefs.hereAnchor;
  if (older && !older.composer && s.composer) {
    await anchorHere(s, await resolvePoint(s, { op: 'herePosition', anchor: older, content }));
  }
  const anchor = s.prefs.hereAnchor;
  if (!anchor) return null;
  // Held against the card: none showing, nothing to follow.
  const box = anchor.composer ? composerBox(s, owner) : content;
  if (!box) return null;
  const shape = geometry(s);
  const target = await resolvePoint(s, { op: 'herePosition', anchor, content: box });
  // The sprite kept inside the app window's content: the clamp rule over the
  // window spots that put the sprite box within it.
  const above = shape.window.height - shape.sprite.bottom - shape.sprite.size;
  const inside = await resolvePoint(s, {
    op: 'clamp',
    point: target,
    size: { width: shape.sprite.size, height: shape.sprite.size },
    workArea: {
      x: content.x - shape.sprite.left,
      y: content.y - above,
      width: content.width,
      height: content.height,
    },
  });
  return clampFree(s, inside, (await displayFor(s, inside)).workArea);
}

/** The spot the pet follows on the app window, per its pin preference; null
 *  when it is not pinned or the window gives none. */
async function followedSpot(s: PetContext): Promise<Point | null> {
  if (s.prefs.pinned) return pinnedSpot(s);
  return s.prefs.pinnedHere ? hereSpot(s) : null;
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
async function layout(s: PetContext) {
  if (!live(s.pet)) {
    pushAppLayout(s);
    return;
  }
  const spot = await followedSpot(s);
  if (!live(s.pet)) {
    pushAppLayout(s);
    return;
  }
  if (spot) await place(s, spot);
  const show =
    s.loaded &&
    s.painted &&
    s.published &&
    // Free on screen: shown apart from the app window (minimised, hidden or
    // on a page with no composer).
    (s.prefs.onScreen || s.composer !== null) &&
    (locked(s) ? Boolean(spot) : s.prefs.keepAbove || s.prefs.onScreen || appShowing(s)) &&
    !occluded(s);
  if (!live(s.pet)) {
    pushAppLayout(s);
    return;
  }
  if (show !== s.pet.isVisible()) {
    if (show) s.pet.showInactive();
    else s.pet.hide();
    // The pet pauses its idle animation while off screen.
    await pushView(s);
  } else if ((await edges(s)).key !== s.sentEdges) {
    // The app window moved under a free pet, or its layers changed: the
    // bubble's span and the cut-outs follow.
    await pushView(s);
  }
  pushAppLayout(s);
}

/** A display went away or changed: keep the pet on a live work area, on
 *  the primary display when its own is gone. */
async function onDisplaysChanged(s: PetContext) {
  if (!live(s.pet)) return;
  if (locked(s)) {
    await layout(s);
    return;
  }
  const point = currentPosition(s);
  const cx = point.x + windowSize(s).width / 2;
  const cy = point.y + windowSize(s).height / 2;
  const onScreen = s.deps.screen
    .getAllDisplays()
    .some(({ workArea: a }) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  if (onScreen) {
    await moveTo(s, point, false);
    return;
  }
  await place(s, await positionOn(s, s.deps.screen.getPrimaryDisplay()));
}

/** Pinned (above the message box or here): it cannot be moved by hand. */
function locked(s: PetContext): boolean {
  return s.prefs.pinned || s.prefs.pinnedHere;
}

/** A pinned pet does not move: unpin it first (menu or Settings). */
async function dragPet(s: PetContext, input: DesktopPetDrag) {
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
  await moveTo(s, point, input.phase === 'end');
  if (input.phase === 'end') s.drag = null;
}

/** A drag input from the pet window: moves are applied newest-first-only
 *  (a move that a later one overtook is dropped), start and end in order. */
function queueDrag(s: PetContext, input: DesktopPetDrag) {
  if (input.phase !== 'move') {
    s.dragMove = null;
    later(s, () => dragPet(s, input));
    return;
  }
  const idle = s.dragMove === null;
  s.dragMove = input;
  if (!idle) return;
  later(s, async () => {
    const next = s.dragMove;
    s.dragMove = null;
    if (next) await dragPet(s, next);
  });
}

/** A live window on the wrong layer is replaced, never re-layered in place. */
async function applyLayer(s: PetContext) {
  if (!live(s.pet) || s.petOwner === wantedOwner(s)) return;
  destroyPetWindow(s);
  await syncPetWindow(s);
}

/** A preference changed from the menu or Settings: both show it. */
async function changed(s: PetContext): Promise<DesktopPetConfig> {
  await pushView(s);
  pushConfig(s);
  return config(s);
}

async function setKeepAbove(s: PetContext, on: boolean) {
  if (s.prefs.keepAbove !== on) save(s, { keepAbove: on });
  await applyLayer(s);
  await layout(s);
  return changed(s);
}

async function setCollapsed(s: PetContext, on: boolean) {
  if (s.prefs.collapsed !== on) save(s, { collapsed: on });
  return changed(s);
}

/** Pinned: stands on the message box and cannot be moved. Unpinned: where
 *  it stands now becomes its free spot, and it can be dragged. */
async function setPinned(s: PetContext, on: boolean) {
  if (s.prefs.pinned !== on) save(s, { pinned: on });
  if (on && s.prefs.pinnedHere) save(s, { pinnedHere: false });
  if (on && s.prefs.onScreen) {
    save(s, { onScreen: false });
    await applyLayer(s);
  }
  s.drag = null;
  if (on) await layout(s);
  else {
    await moveTo(s, currentPosition(s), true);
    await layout(s);
  }
  return changed(s);
}

/** The bot's size. The window keeps one size while it lives (resizing a
 *  transparent window flashes its old frame), so a new scale replaces it
 *  with one made for that scale; a free bot keeps its feet where they stood
 *  (the sprite stands at the window's bottom-left part, the window grows up
 *  and right). */
async function setScale(s: PetContext, scale: number): Promise<DesktopPetConfig> {
  if (s.prefs.scale === scale) return config(s);
  const before = windowSize(s);
  const at = currentPosition(s);
  const wasLive = live(s.pet);
  save(s, { scale });
  await loadShape(s);
  if (wasLive) {
    if (!s.prefs.pinned) {
      const display = await displayFor(s, at);
      const spot = await clampFree(
        s,
        { x: at.x, y: at.y + before.height - windowSize(s).height },
        display.workArea
      );
      save(s, { positions: { ...s.prefs.positions, [String(display.id)]: spot } });
      // Pinned here: the same feet, against the app window.
      if (s.prefs.pinnedHere) await anchorHere(s, spot);
    }
    destroyPetWindow(s);
    await syncPetWindow(s);
  }
  return changed(s);
}

/** "Pin here": locked where it stands now, against the app window (its
 *  distance from the nearest corner of the window's content kept as the
 *  window moves or resizes, and across restarts); turns "Pin above the
 *  message box" off. Off: free and draggable again, where it stands. */
async function setPinnedHere(s: PetContext, on: boolean) {
  if (on && s.prefs.pinned) await setPinned(s, false);
  if (on && s.prefs.onScreen) {
    save(s, { onScreen: false });
    await applyLayer(s);
  }
  if (s.prefs.pinnedHere !== on) save(s, { pinnedHere: on });
  s.drag = null;
  if (on) {
    await moveTo(s, currentPosition(s), true);
    if (live(s.pet)) await anchorHere(s, currentPosition(s));
  } else {
    if (s.prefs.hereAnchor) save(s, { hereAnchor: null });
    if (live(s.pet)) await moveTo(s, currentPosition(s), true);
  }
  await layout(s);
  return changed(s);
}

/** "Free on screen": free and draggable anywhere on its displays, apart
 *  from the app window: a window of its own (owned by none), never clamped
 *  to, moved with or hidden with the app window, its bubble kept to the
 *  screen; turns both pins off. "Keep above other windows" stays its own
 *  choice (the layer only). Off: free as before, following the app window. */
async function setOnScreen(s: PetContext, on: boolean) {
  if (on && s.prefs.pinned) await setPinned(s, false);
  if (on && s.prefs.pinnedHere) await setPinnedHere(s, false);
  if (s.prefs.onScreen !== on) save(s, { onScreen: on });
  s.drag = null;
  await applyLayer(s);
  if (live(s.pet)) await moveTo(s, currentPosition(s), true);
  await layout(s);
  return changed(s);
}

/** One option by name (the app window's Settings). */
async function setOption(s: PetContext, rawName: unknown, rawValue: unknown): Promise<DesktopPetConfig> {
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
async function reset(s: PetContext): Promise<DesktopPetConfig> {
  if (live(s.pet)) {
    const display = await displayFor(s, currentPosition(s));
    const positions = { ...s.prefs.positions };
    delete positions[String(display.id)];
    save(s, { positions });
  }
  if (!s.prefs.pinned || s.prefs.pinnedHere || s.prefs.hereAnchor || s.prefs.onScreen) {
    save(s, { pinned: true, pinnedHere: false, hereAnchor: null, onScreen: false });
  }
  s.drag = null;
  await applyLayer(s);
  await layout(s);
  return changed(s);
}

async function setEnabled(s: PetContext, on: boolean): Promise<DesktopPetConfig> {
  if (s.prefs.enabled !== on) save(s, { enabled: on });
  await syncPetWindow(s);
  pushConfig(s);
  return config(s);
}

/** The pet's own menu (drawn in its window). */
async function runCommand(s: PetContext, command: DesktopPetCommand) {
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
      await setPinnedHere(s, !s.prefs.pinnedHere);
      return;
    case 'on-screen':
      await setOnScreen(s, !s.prefs.onScreen);
      return;
    case 'collapse':
      await setCollapsed(s, !s.prefs.collapsed);
      return;
    case 'keep-above':
      await setKeepAbove(s, !s.prefs.keepAbove);
      return;
    case 'pin':
      await setPinned(s, !s.prefs.pinned);
      return;
    case 'reset':
      await reset(s);
      return;
    case 'off':
      await setEnabled(s, false);
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
    guard(() => later(s, () => pushView(s)))
  );
  // Shown only once the pet has drawn its first frame: a transparent window
  // shown before then flashes an empty box on Windows.
  ipc.on(
    DESKTOP_PET_IPC.painted,
    guard(() => {
      if (s.painted) return;
      s.painted = true;
      if (s.loaded) relayout(s);
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
  // Only a row of an approval the bubble shows now, and only a decision
  // main holds from the published state: the pet window names a row, never a decision.
  ipc.handle(DESKTOP_PET_IPC.decide, async (_event, id, index) => {
    const { bubble, sessionId } = s.state;
    if (!sessionId || bubble.kind !== 'approval' || !Number.isInteger(index)) return false;
    // The bubble shows only the first request.
    const item = bubble.approvals?.[0];
    const row = item && item.id === id && item.inline ? item.rows[index as number] : undefined;
    if (!item || !row) return false;
    return (await s.deps.decideApproval(sessionId, item.id, row.decision)) === true;
  });
  ipc.on(
    DESKTOP_PET_IPC.command,
    guard((value) => {
      const command = requiredDesktopPetCommand(value);
      later(s, () => runCommand(s, command));
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.area,
    guard((value) => {
      s.area = requiredDesktopPetComposerRect(value);
      relayout(s);
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.drag,
    guard((value) => queueDrag(s, requiredDesktopPetDrag(value)))
  );
  ipc.on(
    DESKTOP_PET_IPC.nudge,
    guard((dx, dy) => {
      const delta = requiredDesktopPetNudge(dx, dy);
      later(s, async () => {
        if (locked(s)) return;
        const point = currentPosition(s);
        await moveTo(s, { x: point.x + delta.dx, y: point.y + delta.dy }, true);
      });
    })
  );
  ipc.on(
    DESKTOP_PET_IPC.reset,
    guard(() => later(s, () => reset(s)))
  );
  ipc.on(
    DESKTOP_PET_IPC.scale,
    guard((scale) => {
      const next = requiredDesktopPetScale(scale);
      later(s, () => setScale(s, next));
    })
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
  const at = (await followedSpot(s)) ?? (await positionOn(s, homeDisplay(s)));
  // The window is made after the placement answered: another step may have made it meanwhile.
  if (live(s.pet) || s.disposed) return;
  s.petOwner = wantedOwner(s);
  const { flipped, x, y } = await windowAt(s, at);
  if (live(s.pet) || s.disposed) return;
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
  // The page loads outside the queue: a slow load holds nothing else up.
  void finishLoad(s, window).catch((error: unknown) => fail(s, 'desktop pet window', error));
}

async function finishLoad(s: PetContext, window: PetWindow) {
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
  relayout(s);
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
async function syncPetWindow(s: PetContext) {
  // Following the app window needs one to belong to.
  if (
    s.started &&
    s.shape &&
    s.prefs.enabled &&
    s.available &&
    (s.prefs.keepAbove || s.prefs.onScreen || appWindow(s))
  ) {
    await createPetWindow(s);
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
    relayout(s);
  };
  contents.on('did-navigate', onReload);
  contents.on('render-process-gone', onReload);
  const publish = applyValid(requiredDesktopPetState, (next) => {
    s.state = next;
    const first = !s.published;
    s.published = true;
    later(s, async () => {
      await pushView(s);
      // Another look: another art width for the island to clear.
      pushAppLayout(s);
      if (first) await layout(s);
    });
  });
  const onComposer = applyValid(requiredDesktopPetComposer, (next) => {
    s.composer = next;
    relayout(s);
  });
  const onTheme = applyValid(requiredDesktopPetTheme, (next) => {
    s.theme = next;
    later(s, () => pushView(s));
  });
  const onLayers = applyValid(requiredDesktopPetLayers, (next) => {
    s.layers = next.rects;
    s.backdrop = next.backdrop;
    relayout(s);
  });
  const onAvailable: Listener = (_event, value) => {
    if (typeof value !== 'boolean') return;
    later(s, () => {
      if (s.available === value) return;
      s.available = value;
      return syncPetWindow(s);
    });
  };
  ipc.on(DESKTOP_PET_IPC.publish, publish);
  ipc.on(DESKTOP_PET_IPC.composer, onComposer);
  ipc.on(DESKTOP_PET_IPC.theme, onTheme);
  ipc.on(DESKTOP_PET_IPC.layers, onLayers);
  ipc.on(DESKTOP_PET_IPC.available, onAvailable);
  ipc.handle(DESKTOP_PET_IPC.getConfig, () => enqueue(s, () => config(s)));
  ipc.handle(DESKTOP_PET_IPC.setEnabled, (_event, on) => {
    if (typeof on !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return enqueue(s, () => setEnabled(s, on));
  });
  ipc.handle(DESKTOP_PET_IPC.setOption, (_event, name, value) => enqueue(s, () => setOption(s, name, value)));
  ipc.handle(DESKTOP_PET_IPC.setScale, (_event, scale) => {
    const next = requiredDesktopPetScale(scale);
    return enqueue(s, () => setScale(s, next));
  });
  ipc.handle(DESKTOP_PET_IPC.resetPosition, () => enqueue(s, () => reset(s)));
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
  const follow = () => relayout(s);
  for (const event of APP_WINDOW_EVENTS) window.on(event, follow);
  const detach = () => {
    if (s.detachApp !== detach) return;
    s.detachApp = null;
    if (s.app === window) {
      s.app = null;
      s.composer = null;
      s.layers = [];
      s.backdrop = false;
    }
    for (const event of APP_WINDOW_EVENTS) window.removeListener(event, follow);
    window.removeListener('closed', detach);
    stopListening();
    later(s, async () => {
      await applyLayer(s);
      await layout(s);
    });
  };
  s.detachApp = detach;
  window.on('closed', detach);
  // An owned pet goes with a closed owner: a new app window brings it back.
  later(s, async () => {
    await syncPetWindow(s);
    await applyLayer(s);
    await layout(s);
  });
}

export function createDesktopPet(deps: DesktopPetDeps) {
  const s: PetContext = {
    deps,
    prefs: PREFS_UNREAD,
    shape: null,
    tail: Promise.resolve(),
    writing: Promise.resolve(),
    layoutQueued: false,
    dragMove: null,
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
  // The settings come from the core before any other step runs.
  later(s, () => loadPrefs(s));

  const onScreenChange = () => later(s, () => onDisplaysChanged(s));
  deps.screen.on('display-removed', onScreenChange);
  deps.screen.on('display-metrics-changed', onScreenChange);

  return {
    /** App ready: the window opens once the setting is on and the
     *  representative bot exists. */
    start() {
      s.started = true;
      later(s, () => syncPetWindow(s));
    },
    /** Whether the representative bot exists (tests; the app window reports it). */
    setAvailable(on: boolean) {
      later(s, () => {
        if (s.available === on) return;
        s.available = on;
        return syncPetWindow(s);
      });
    },
    config: () => config(s),
    setEnabled: (on: boolean) => enqueue(s, () => setEnabled(s, on)),
    setOption: (name: unknown, value: unknown) => enqueue(s, () => setOption(s, name, value)),
    setScale: (scale: unknown) => {
      const next = requiredDesktopPetScale(scale);
      return enqueue(s, () => setScale(s, next));
    },
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
