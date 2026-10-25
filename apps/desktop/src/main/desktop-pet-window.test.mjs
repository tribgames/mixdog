import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  DESKTOP_PET_IPC as APP_IPC,
  DESKTOP_PET_CORE_WIDTH,
  DESKTOP_PET_ISLAND,
  DESKTOP_PET_MENU,
  DESKTOP_PET_SPRITE,
  DESKTOP_PET_WINDOW,
  desktopPetAppLayout,
  desktopPetGeometry,
} from '../shared/desktop-pet.ts';
import { DESKTOP_PET_WINDOW_IPC } from '../shared/desktop-pet-bridge.ts';
import { createDesktopPet } from './desktop-pet-window.ts';
import { agentHomeSessionId, MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  clampPetPosition,
  defaultPetPosition,
  DESKTOP_PET_MARGIN,
  DESKTOP_PET_PIN_INSET,
  normalizeDesktopPetPrefs,
  pinnedPetPosition,
} from './desktop-pet-store.ts';
import {
  requiredDesktopPetCommand,
  requiredDesktopPetComposer,
  requiredDesktopPetComposerRect,
  requiredDesktopPetDrag,
  requiredDesktopPetNudge,
  requiredDesktopPetOption,
  requiredDesktopPetScale,
  requiredDesktopPetState,
  requiredDesktopPetText,
  requiredDesktopPetTheme,
} from './ipc-validation.ts';

const DESKTOP_PET_IPC = { ...APP_IPC, ...DESKTOP_PET_WINDOW_IPC };
const SIZE = DESKTOP_PET_WINDOW;
/** The 100% window and sprite (today's look). */
const GEOMETRY = desktopPetGeometry(100);
const PRIMARY = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SECOND = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } };
const APP_CONTENT = { x: 100, y: 100, width: 1200, height: 800 };
/** Free floating: the tests of the saved-spot behaviour. */
const FREE = { enabled: true, pinned: false };

/** A webContents whose `ipc` records listeners and handlers like Electron's. */
function fakeContents() {
  const listeners = new Map();
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, ...args) {
      sent.push([channel, ...args]);
    },
    ipc: {
      on(channel, listener) {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener(channel, listener) {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((entry) => entry !== listener)
        );
      },
      handle(channel, handler) {
        if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    emit(channel, ...args) {
      for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    },
    handles: (channel) => handlers.has(channel),
    lastView: () => sent.filter(([channel]) => channel === DESKTOP_PET_IPC.view).at(-1)?.[1],
  };
}

function fakeWindow(bounds, layer) {
  const events = new EventEmitter();
  const window = {
    bounds: { ...bounds },
    alwaysOnTop: layer.alwaysOnTop,
    parent: layer.parent,
    /** Calls that change a live window's layer (they move focus on Windows). */
    relayered: 0,
    ignore: null,
    focused: false,
    shown: false,
    destroyed: false,
    webContents: fakeContents(),
    isDestroyed: () => window.destroyed,
    destroy() {
      window.destroyed = true;
      events.emit('closed');
    },
    getPosition: () => [window.bounds.x, window.bounds.y],
    /** Test-only: the user's own placement. */
    setPosition(x, y) {
      window.bounds.x = x;
      window.bounds.y = y;
    },
    setBounds(next) {
      window.bounds = { ...next };
    },
    setAlwaysOnTop() {
      window.relayered += 1;
    },
    setParentWindow() {
      window.relayered += 1;
    },
    setIgnoreMouseEvents(ignore, options) {
      window.ignore = { ignore, forward: options?.forward === true };
    },
    focus() {
      window.focused = true;
    },
    blur() {
      window.focused = false;
    },
    isFocused: () => window.focused,
    shows: [],
    showInactive() {
      window.shown = true;
      window.shows.push({ ...window.bounds });
    },
    hide() {
      window.shown = false;
    },
    isVisible: () => window.shown,
    on(event, listener) {
      events.on(event, listener);
    },
    events,
  };
  return window;
}

function fakeScreen(displays = [PRIMARY]) {
  const events = new EventEmitter();
  return {
    displays,
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (rect) =>
      displays.find(
        ({ workArea: a }) => rect.x >= a.x && rect.x < a.x + a.width && rect.y >= a.y && rect.y < a.y + a.height
      ) ?? displays[0],
    on: (event, listener) => events.on(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener),
    emit: (event) => events.emit(event),
    listeners: (event) => events.listenerCount(event),
  };
}

function fakeApp() {
  const app = {
    webContents: fakeContents(),
    events: new EventEmitter(),
    content: { ...APP_CONTENT },
    zoom: 1,
    visible: true,
    minimized: false,
  };
  app.webContents.getZoomFactor = () => app.zoom;
  const contentsEvents = new EventEmitter();
  app.webContents.on = (event, listener) => contentsEvents.on(event, listener);
  app.webContents.removeListener = (event, listener) => contentsEvents.removeListener(event, listener);
  /** A webContents event (a reload starting, the renderer gone). */
  app.webContents.fire = (event, ...args) => contentsEvents.emit(event, ...args);
  app.isDestroyed = () => false;
  app.getBounds = () => ({ ...app.content });
  app.getContentBounds = () => ({ ...app.content });
  app.isVisible = () => app.visible;
  app.isMinimized = () => app.minimized;
  app.on = (event, listener) => app.events.on(event, listener);
  app.removeListener = (event, listener) => app.events.removeListener(event, listener);
  /** Fire an app-window event after changing its state. */
  app.fire = (event, change = {}) => {
    Object.assign(app, change);
    app.events.emit(event);
  };
  return app;
}

function setup({
  prefs = {},
  displays,
  submitResult = true,
  available = true,
  paint = true,
  pageLoaded = Promise.resolve(),
  avatarImage,
} = {}) {
  let stored = normalizeDesktopPetPrefs(prefs);
  const screen = fakeScreen(displays);
  const windows = [];
  const calls = { submit: [], open: [], read: [], copy: [], writes: 0 };
  const pet = createDesktopPet({
    prefsPath: 'pet.json',
    screen,
    readPrefs: () => stored,
    writePrefs: (_path, next) => {
      stored = next;
      calls.writes += 1;
    },
    createWindow: (bounds, layer) => {
      const window = fakeWindow(bounds, layer);
      windows.push(window);
      return window;
    },
    // The pet renderer draws its first frame while loading, unless told not to.
    load: async (window) => {
      await pageLoaded;
      if (paint) window.webContents.emit(DESKTOP_PET_IPC.painted);
    },
    submit: async (sessionId, text) => {
      calls.submit.push([sessionId, text]);
      return submitResult;
    },
    openApp: (sessionId) => calls.open.push(sessionId),
    markRead: (sessionId) => calls.read.push(sessionId),
    copyText: (text) => calls.copy.push(text),
    avatarImage,
  });
  const app = fakeApp();
  pet.attachAppWindow(app);
  // The app window answers whether the representative bot exists.
  if (available) app.webContents.emit(DESKTOP_PET_IPC.available, true);
  return { pet, screen, windows, calls, app, stored: () => stored };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** The app window's composer card after boot (CSS px). */
const BOOT_COMPOSER = { x: 300, y: 600, width: 700, height: 120 };
/** The app renderer's first published state: nothing to say yet. */
const BOOT_STATE = {
  sessionId: agentHomeSessionId(MIXY_AGENT_ID),
  bubble: { kind: 'idle' },
  face: { room: false, members: [] },
  quiet: false,
};
/** Started, with the app booted (its first state published, its composer
 *  laid out) unless `published: false` / `composer: null`. */
const started = async ({ composer = BOOT_COMPOSER, published = true, ...options } = {}) => {
  const context = setup(options);
  context.pet.start();
  if (published) context.app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  if (composer) context.app.webContents.emit(DESKTOP_PET_IPC.composer, composer);
  await tick();
  return { ...context, window: context.windows[0] };
};
const position = (window) => [window.bounds.x, window.bounds.y];
/** The last setting the app window heard. */
const lastConfig = (app) => app.webContents.sent.filter(([channel]) => channel === DESKTOP_PET_IPC.config).at(-1)?.[1];
const MIXY = agentHomeSessionId(MIXY_AGENT_ID);
const STATE = {
  sessionId: MIXY,
  bubble: { kind: 'reply', key: 'turn-1', text: 'Fixed the build.\nAll tests pass.' },
  face: { room: false, members: [{ id: 'mixy', name: 'Mixy', avatar: { kind: 'mascot', species: 'mixy' } }] },
  quiet: false,
};
const command = (window, name) => window.webContents.emit(DESKTOP_PET_IPC.command, name);

// ---- Life -----------------------------------------------------------------------

test('the overlay is on by default; off persists across a restart; on and quit', async () => {
  const fresh = await started();
  assert.deepEqual(fresh.pet.config(), {
    enabled: true,
    pinned: true,
    pinnedHere: false,
    onScreen: false,
    keepAbove: false,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
  });
  assert.equal(fresh.windows.length, 1, 'opens at start by default');
  assert.deepEqual(await fresh.app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, false), {
    enabled: false,
    pinned: true,
    pinnedHere: false,
    onScreen: false,
    keepAbove: false,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
  });
  assert.equal(fresh.window.destroyed, true);
  assert.equal(fresh.stored().enabled, false, 'an explicit off is written');
  fresh.pet.dispose();
  const { pet, windows, app, screen } = await started({ prefs: fresh.stored() });
  assert.equal(windows.length, 0, 'a stored off stays off after restart');
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, true);
  await tick();
  assert.equal(windows.length, 1);
  const [window] = windows;
  assert.equal(window.shown, true, 'shown without taking focus');
  assert.equal(window.focused, false);
  assert.deepEqual(window.ignore, { ignore: true, forward: true }, 'empty pixels click through');
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, true);
  await tick();
  assert.equal(windows.length, 1, 'a second on opens no second window');
  command(window, 'off');
  assert.equal(window.destroyed, true);
  assert.equal(pet.window(), null);
  assert.equal(lastConfig(app).enabled, false, 'Settings hears the menu turning it off');
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, true);
  await tick();
  pet.dispose();
  assert.equal(windows[1].destroyed, true, 'quit destroys the window');
  assert.equal(screen.listeners('display-removed'), 0);
  assert.throws(() => app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, true), /no handler/);
});

test('no representative bot, no overlay: it appears when the bot exists and goes when it is removed', async () => {
  const { pet, app, windows, stored } = await started({ available: false });
  assert.equal(windows.length, 0, 'on, but no representative bot yet: no window');
  app.webContents.emit(DESKTOP_PET_IPC.available, true);
  await tick();
  assert.equal(windows.length, 1, 'the bot was created: it appears');
  assert.equal(windows[0].shown, true);
  app.webContents.emit(DESKTOP_PET_IPC.available, false);
  assert.equal(windows[0].destroyed, true, 'the bot was removed: it goes');
  assert.equal(stored().enabled, true, 'the stored setting is not touched');
  assert.equal(pet.config().enabled, true);
  // Turning it on from Settings while there is no bot opens nothing either.
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, true);
  await tick();
  assert.equal(windows.length, 1);
  app.webContents.emit(DESKTOP_PET_IPC.available, 'yes');
  await tick();
  assert.equal(windows.length, 1, 'a malformed answer changes nothing');
});

test('the pet appears with the composer, not before: first shown already at its pinned spot', async () => {
  const { app, windows } = await started({ composer: null });
  const [window] = windows;
  assert.ok(window, 'the window is made (hidden) while the app boots');
  assert.equal(window.shown, false, 'no composer yet: not shown');
  assert.deepEqual(window.shows, []);
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, true);
  assert.equal(window.shows.length, 1);
  const pinned = pinnedPetPosition(APP_CONTENT, BOOT_COMPOSER, 1, GEOMETRY);
  assert.deepEqual(
    [window.shows[0].x, window.shows[0].y],
    [pinned.x, pinned.y],
    'the very first frame is at the pinned spot: no jump'
  );
  assert.equal(window.webContents.lastView().visible, true, 'the pet knows it is on screen');
  // The composer goes (settings page, onboarding): hidden until it comes back.
  app.webContents.emit(DESKTOP_PET_IPC.composer, null);
  assert.equal(window.shown, false);
  assert.equal(window.webContents.lastView().visible, false, 'its idle animation pauses');
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, true);
  // A renderer reload (or crash) takes the composer with it.
  app.webContents.fire('did-navigate');
  assert.equal(window.shown, false);
  app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, true);
  app.webContents.fire('render-process-gone');
  assert.equal(window.shown, false);
});

test('unpinned, the pet also waits for the composer', async () => {
  const { app, window } = await started({ prefs: FREE, composer: null });
  assert.equal(window.shown, false);
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, true);
  assert.equal(window.shows.length, 1);
});

test('an iframe loading or an in-page navigation in the app window is not a reload: the pet stays', async () => {
  const { app, window } = await started();
  assert.equal(window.shown, true);
  // Electron fires these on the app's webContents for a chat's inline
  // visualize/preview frame loading, for history.pushState and for a link
  // the window's navigation guard blocks (Electron 41): the page and its
  // renderer state are unchanged, and it publishes nothing again.
  app.webContents.fire('did-start-loading');
  app.webContents.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  app.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  app.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(window.shown, true, 'still on the message box');
  // The app page replaced (a reload committed) hides it until the new page publishes.
  app.webContents.fire('did-navigate');
  assert.equal(window.shown, false);
  app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, true);
});

// ---- Layer -----------------------------------------------------------------------

test('by default the pet follows the app window: owned by it, not above other windows', async () => {
  const { window, app, stored } = await started({ prefs: { ...FREE, alwaysOnTop: true } });
  assert.equal(stored().keepAbove, false, "an older build's alwaysOnTop is not a choice: the default");
  assert.equal(window.parent, app, 'owned by the app window');
  assert.equal(window.alwaysOnTop, false);
  // Minimised or hidden with the app window, back with it (even unpinned).
  app.fire('minimize', { minimized: true });
  assert.equal(window.shown, false);
  app.fire('restore', { minimized: false });
  assert.equal(window.shown, true);
});

test('"Keep above other windows" puts it above every window, persists, and shows in Settings', async () => {
  const { pet, window: first, windows, app, stored } = await started({ prefs: FREE });
  command(first, 'keep-above');
  await tick();
  // A new window on the new layer replaces the old one: a live window is
  // never re-layered (that moves the app window's focus on Windows).
  assert.equal(first.destroyed, true);
  const window = windows.at(-1);
  assert.equal(window.parent, null, 'no owner');
  assert.equal(window.alwaysOnTop, true);
  assert.equal(window.shown, true);
  assert.equal(stored().keepAbove, true);
  assert.equal(window.webContents.lastView().keepAbove, true, 'the menu shows it checked');
  assert.equal(lastConfig(app).keepAbove, true, 'Settings shows it checked');
  // A free pet above other windows stays when the app window is minimised.
  app.fire('minimize', { minimized: true });
  assert.equal(window.shown, true);
  app.fire('restore', { minimized: false });
  // From Settings: back to following the app window.
  assert.equal((await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'keepAbove', false)).keepAbove, false);
  await tick();
  const owned = windows.at(-1);
  assert.equal(owned.parent, app);
  assert.equal(owned.alwaysOnTop, false);
  assert.equal(
    windows.reduce((sum, each) => sum + each.relayered, 0),
    0,
    'no live window changed its owner or topmost state'
  );
  pet.dispose();
  const restarted = await started({ prefs: { ...stored(), keepAbove: true } });
  assert.equal(restarted.window.alwaysOnTop, true, 'persisted');
  assert.equal(restarted.window.parent, null);
});

test('Settings toggles never take focus from the app window; a closed quick message hands focus back', async () => {
  const { app, windows } = await started();
  for (const [name, value] of [
    ['collapsed', true],
    ['collapsed', false],
    ['pinned', false],
    ['pinned', true],
  ]) {
    await app.webContents.invoke(DESKTOP_PET_IPC.setOption, name, value);
  }
  await app.webContents.invoke(DESKTOP_PET_IPC.resetPosition);
  await tick();
  assert.equal(windows.length, 1, 'the same window throughout');
  const [window] = windows;
  assert.equal(window.focused, false, 'never focused');
  assert.equal(window.relayered, 0);
  window.webContents.emit(DESKTOP_PET_IPC.focusInput, true);
  assert.equal(window.focused, true, 'the user clicked the pet');
  window.webContents.emit(DESKTOP_PET_IPC.focusInput, false);
  assert.equal(window.focused, false, 'closed again: focus goes back to the window below');
});

test('the overlay stays hidden until the app renderer published its first state (no bot over a black boot screen)', async () => {
  const { app, window } = await started({ published: false });
  assert.ok(window, 'the window is made (hidden) meanwhile');
  assert.equal(window.shown, false, 'composer laid out, but no state yet: hidden');
  app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  assert.equal(window.shown, true, 'the app renderer is up: shown');
  assert.equal(window.shows.length, 1);
  // A reload takes the app back to its boot screen: hidden until it publishes again.
  app.webContents.fire('did-navigate');
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.shown, false);
  app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  assert.equal(window.shown, true);
});

// ---- Free placement ------------------------------------------------------------------

test('unpinned, the window opens at the default corner of the app window display', async () => {
  const { window } = await started({ prefs: FREE, displays: [PRIMARY, SECOND] });
  const expected = defaultPetPosition(PRIMARY.workArea, SIZE);
  assert.deepEqual(expected, {
    x: 1920 - SIZE.width - DESKTOP_PET_MARGIN,
    y: 1040 - SIZE.height - DESKTOP_PET_MARGIN,
  });
  assert.deepEqual(window.bounds, { ...expected, ...SIZE });
});

test('unpinned, dragging moves the window, clamps the bot to the work area and saves the spot per display', async () => {
  const { window, stored } = await started({ prefs: FREE, displays: [PRIMARY, SECOND] });
  const contents = window.webContents;
  const start = { ...window.bounds };
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1800, screenY: 900 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'move', screenX: 1700, screenY: 850 });
  assert.deepEqual(position(window), [start.x - 100, start.y - 50]);
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'move', screenX: -5000, screenY: -5000 });
  assert.deepEqual(
    position(window),
    [-DESKTOP_PET_SPRITE.left, -DESKTOP_PET_SPRITE.bottom],
    'the sprite box at the corner (the window flipped at the top)'
  );
  assert.deepEqual(stored().positions, {}, 'nothing saved mid-drag');
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 1000, screenY: 500 });
  const dropped = { x: start.x - 800, y: start.y - 400 };
  assert.deepEqual(position(window), [dropped.x, dropped.y]);
  assert.deepEqual(stored().positions, { 1: dropped });
  assert.deepEqual([window.bounds.width, window.bounds.height], [SIZE.width, SIZE.height], 'the size never changes');
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 0, screenY: 0 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 1500, screenY: 0 });
  assert.deepEqual(stored().positions[2], { x: dropped.x + 1500, y: dropped.y });
  assert.deepEqual(stored().positions[1], dropped, 'the first display keeps its own spot');
  contents.emit(DESKTOP_PET_IPC.nudge, -500, 8);
  assert.deepEqual(position(window), [dropped.x + 1500 - 64, dropped.y + 8]);
  assert.deepEqual(stored().positions[2], { x: dropped.x + 1500 - 64, y: dropped.y + 8 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'teleport', screenX: 0, screenY: 0 });
  contents.emit(DESKTOP_PET_IPC.nudge, 'a', 1);
  assert.equal(window.bounds.x, dropped.x + 1500 - 64);
});

test('unpinned, a saved spot is restored (clamped)', async () => {
  const { window } = await started({ prefs: { ...FREE, positions: { 1: { x: 5000, y: 300 } } } });
  assert.deepEqual(
    position(window),
    [1920 - DESKTOP_PET_SPRITE.left - DESKTOP_PET_SPRITE.size, 300],
    'the bot clamped into the work area'
  );
});

test('a removed display moves a free pet onto the primary display; a resized one keeps it inside', async () => {
  const displays = [PRIMARY, SECOND];
  const { window, screen } = await started({ prefs: { ...FREE, positions: { 1: { x: 400, y: 200 } } }, displays });
  window.setPosition(2500, 500);
  displays.splice(1, 1);
  screen.emit('display-removed');
  assert.deepEqual(position(window), [400, 200], "the primary display's saved spot");
  PRIMARY.workArea.height = 400;
  screen.emit('display-metrics-changed');
  assert.ok(window.bounds.y + SIZE.height <= 400);
  PRIMARY.workArea.height = 1040;
});

test('clampPetPosition keeps the whole window inside the work area', () => {
  assert.deepEqual(clampPetPosition({ x: -10, y: 9999 }, SIZE, PRIMARY.workArea), { x: 0, y: 1040 - SIZE.height });
});

// #179: the free bot was held 228px inside the screen's sides (and 244px
// below its top) by its transparent window: on a maximised app window it
// looked boxed into the app's area.
test('free (kept above other windows), the dragged bot reaches both side edges of the screen, at every scale', async () => {
  for (const scale of [50, 100, 200]) {
    const { window, stored } = await started({ prefs: { ...FREE, keepAbove: true, scale } });
    assert.equal(window.parent, null, 'above every window, owned by none');
    const { sprite, window: size } = desktopPetGeometry(scale);
    const drag = (dx, dy) => {
      const at = { ...window.bounds };
      window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1000, screenY: 500 });
      window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 1000 + dx, screenY: 500 + dy });
      return at;
    };
    drag(-5000, 0);
    assert.equal(window.bounds.x + sprite.left, 0, `${scale}%: the sprite box at the left edge`);
    drag(5000, 5000);
    assert.equal(window.bounds.x + sprite.left + sprite.size, 1920, `${scale}%: the sprite box at the right edge`);
    assert.equal(window.bounds.y + size.height, 1040, `${scale}%: the window's bottom on the work area's`);
    assert.deepEqual(stored().positions[1], { x: window.bounds.x, y: window.bounds.y }, 'saved');
    assert.equal(window.webContents.lastView().flipped, false);
    // Restarted: the saved edge spot comes back as it was.
    const again = await started({ prefs: stored() });
    assert.deepEqual(position(again.window), [window.bounds.x, window.bounds.y], `${scale}%: restored at the edge`);
  }
});

const spriteTop = (window, scale = 100) => {
  const { sprite, window: size } = desktopPetGeometry(scale);
  return window.webContents.lastView().flipped
    ? window.bounds.y + sprite.bottom
    : window.bounds.y + size.height - sprite.bottom - sprite.size;
};

test('free, the bot reaches the top edge: the window flips (bubble, quick message, menu below it), at every scale', async () => {
  for (const scale of [50, 100, 200]) {
    const { window, stored } = await started({ prefs: { ...FREE, scale } });
    const { sprite, window: size } = desktopPetGeometry(scale);
    const drag = (dx, dy) => {
      window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1000, screenY: 500 });
      window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 1000 + dx, screenY: 500 + dy });
    };
    drag(0, -5000);
    assert.equal(window.webContents.lastView().flipped, true, `${scale}%: flipped at the top`);
    assert.equal(spriteTop(window, scale), 0, `${scale}%: the sprite box at the top edge`);
    assert.equal(window.bounds.y, -sprite.bottom, `${scale}%: the window hangs down from just above the bot`);
    assert.ok(window.bounds.y + size.height <= 1040, 'the room below it on screen');
    // Dragged on from there, the bot follows the pointer one to one (no jump at the flip).
    drag(0, 150);
    assert.equal(spriteTop(window, scale), 150, `${scale}%: still under the pointer`);
    drag(0, 400);
    assert.equal(window.webContents.lastView().flipped, false, `${scale}%: room above again: unflipped`);
    assert.equal(spriteTop(window, scale), 550);
    drag(0, -5000);
    // Restarted at the top: flipped again, at the same place.
    const again = await started({ prefs: stored() });
    assert.equal(again.window.webContents.lastView().flipped, true);
    assert.equal(spriteTop(again.window, scale), 0, `${scale}%: restored at the top`);
  }
});

test('the composer-pinned bot never flips; "Pin here" at the top keeps its flip', async () => {
  const pinned = await started();
  pinned.app.webContents.emit(DESKTOP_PET_IPC.composer, { x: 300, y: -80, width: 700, height: 120 });
  assert.equal(pinned.window.webContents.lastView().flipped, false);
  assert.equal(pinned.window.bounds.y, 0, 'its whole window on screen, as before');
  const here = await started({ prefs: FREE });
  here.app.fire('move', { content: { x: 0, y: 0, width: 1920, height: 1040 } });
  here.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1000, screenY: 500 });
  here.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 1000, screenY: -5000 });
  command(here.window, 'pin-here');
  assert.equal(here.window.webContents.lastView().flipped, true);
  assert.equal(spriteTop(here.window), 0);
  here.app.fire('resize', { content: { x: 0, y: 0, width: 1800, height: 1000 } });
  assert.equal(spriteTop(here.window), 0, 'kept at the top against the app window');
});

test('"Free on screen": anywhere on screen apart from the app window, with or without "Keep above"; exclusive with both pins; kept across a restart', async () => {
  for (const keepAbove of [false, true]) {
    const { pet, window: first, windows, app, stored } = await started({ prefs: { keepAbove } });
    command(first, 'on-screen');
    await tick();
    assert.deepEqual(
      [lastConfig(app).onScreen, lastConfig(app).pinned, lastConfig(app).pinnedHere],
      [true, false, false],
      'the menu turns it on and the composer pin off'
    );
    const window = windows.at(-1);
    assert.equal(window.parent, null, 'a window of its own, never owned by the app window');
    assert.equal(window.alwaysOnTop, keepAbove, '"Keep above" stays its own choice');
    assert.equal(window.webContents.lastView().onScreen, true);
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1000, screenY: 500 });
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: -9000, screenY: 9000 });
    assert.equal(window.bounds.x + GEOMETRY.sprite.left, 0, 'at the screen edge, outside the app window');
    // Over the app window: the bubble still keeps to the screen, not the app's content.
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 0, screenY: 0 });
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 500, screenY: -400 });
    assert.deepEqual(window.webContents.lastView().bubbleSpan, {
      left: Math.max(0, -window.bounds.x),
      right: Math.min(SIZE.width, 1920 - window.bounds.x),
    });
    const at = position(window);
    app.fire('move', { content: { x: 900, y: 500, width: 400, height: 300 } });
    assert.deepEqual(position(window), at, 'never moved with the app window');
    app.fire('minimize', { minimized: true });
    assert.equal(window.shown, true, 'not hidden with the minimised app window');
    app.fire('restore', { minimized: false });
    app.webContents.emit(DESKTOP_PET_IPC.composer, null);
    assert.equal(window.shown, true, 'nor on an app page with no composer');
    assert.equal(stored().onScreen, true);
    pet.dispose();
    const again = await started({ prefs: stored() });
    assert.equal(again.window.parent, null);
    assert.deepEqual(position(again.window), at, 'restored where it was');
    command(again.window, 'pin-here');
    await tick();
    assert.deepEqual([lastConfig(again.app).onScreen, lastConfig(again.app).pinnedHere], [false, true]);
    command(again.windows.at(-1), 'on-screen');
    await tick();
    command(again.windows.at(-1), 'pin');
    await tick();
    assert.deepEqual([lastConfig(again.app).onScreen, lastConfig(again.app).pinned], [false, true]);
    assert.equal(again.windows.at(-1).parent, keepAbove ? null : again.app, 'pinned: following the app again');
  }
  assert.equal(normalizeDesktopPetPrefs({ pinned: false, onScreen: true }).onScreen, true);
  assert.equal(normalizeDesktopPetPrefs({ onScreen: true }).onScreen, false, 'never with the composer pin');
  assert.equal(normalizeDesktopPetPrefs({ pinned: false, pinnedHere: true, onScreen: true }).onScreen, false);
});

// #179 follow-up: what each placement allows. Pinned (composer) and "Pin
// here" are locked to the app window (other tests); free is placed on the
// screen alone: the same with or without "Keep above other windows", and
// never moved or clamped by the app window.
test('free, placement is the screen\'s, the same with or without "Keep above", never the app window\'s', async () => {
  const spots = [];
  for (const keepAbove of [false, true]) {
    const { window, app } = await started({ prefs: { ...FREE, keepAbove } });
    assert.equal(window.parent, keepAbove ? null : app, keepAbove ? 'above every window' : "on the app window's layer");
    // The app window is small, in the middle; the bot goes to the screen's bottom-right corner, far outside it.
    app.fire('move', { content: { x: 600, y: 300, width: 700, height: 400 } });
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 1000, screenY: 500 });
    window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 6000, screenY: 6000 });
    const left = () => window.bounds.x + GEOMETRY.sprite.left;
    assert.equal(left() + GEOMETRY.sprite.size, 1920, 'at the screen edge, outside the app window');
    assert.ok(left() > 600 + 700);
    app.fire('move', { content: { x: 100, y: 100, width: 500, height: 300 } });
    assert.equal(left() + GEOMETRY.sprite.size, 1920, 'the app window moving does not move it');
    assert.equal(window.shown, true);
    spots.push(position(window));
  }
  assert.deepEqual(spots[0], spots[1], 'keepAbove changes the layer only, never where it may go');
});

// #178: a representative bot whose look is an uploaded picture showed
// Mixy's fixed pup: the pet window dropped the picture.
test('the pet window reads the face\'s custom picture through main; nothing for another agent or a mascot', async () => {
  const asked = [];
  const answer = { states: { idle: { file: 'idle-0123456789ab.png', url: 'data:image/png;base64,AAAA', poster: '' } } };
  const { window, app } = await started({
    avatarImage: async (id) => {
      asked.push(id);
      return answer;
    },
  });
  const custom = { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } };
  const face = (avatar) => ({ room: false, members: [{ id: MIXY_AGENT_ID, name: '하치와레', avatar }] });
  app.webContents.emit(DESKTOP_PET_IPC.publish, { ...STATE, face: face(custom) });
  assert.deepEqual(window.webContents.lastView().face.members[0].avatar, custom, 'the picture look reaches the pet');
  assert.deepEqual(await window.webContents.invoke(DESKTOP_PET_IPC.avatarImage, MIXY_AGENT_ID), answer);
  assert.equal(await window.webContents.invoke(DESKTOP_PET_IPC.avatarImage, 'someone-else'), null);
  app.webContents.emit(DESKTOP_PET_IPC.publish, {
    ...STATE,
    face: face({ kind: 'mascot', species: 'shiba', color: '#5b9bff' }),
  });
  assert.equal(await window.webContents.invoke(DESKTOP_PET_IPC.avatarImage, MIXY_AGENT_ID), null);
  assert.deepEqual(asked, [MIXY_AGENT_ID]);
});

test('a picture face: kept as the look, drawn from its idle still, a mascot only in its place', async () => {
  const { petMemberAvatar, petFallbackAvatar, petMascotCells, petPictureSource } = await import(
    '../shared/desktop-pet-art.ts'
  );
  const { MIXY_AVATAR: pup, mascotCells: cells } = await import('../../../../src/runtime/shared/agent-avatar.mjs');
  const custom = { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } };
  const member = { id: MIXY_AGENT_ID, name: '하치와레', avatar: custom };
  assert.deepEqual(petMemberAvatar(member), custom);
  assert.deepEqual(petFallbackAvatar(member), { ...pup });
  const face = { room: false, members: [member] };
  assert.deepEqual(petMascotCells(face), [], 'a picture fills the box (no feet gap, the whole box reserved)');
  assert.deepEqual(petMascotCells(face, true), cells(pup), 'the mascot shown until it is read');
  const idle = { file: 'idle-0123456789ab.png', url: 'data:image/gif;base64,R0lG', poster: 'data:image/png;base64,iVBO' };
  assert.equal(petPictureSource(custom, { states: { idle } }), idle.poster, 'a moving picture: its first frame');
  assert.equal(petPictureSource(custom, { states: { idle: { ...idle, poster: '' } } }), idle.url);
  assert.equal(petPictureSource(custom, { states: { idle: { ...idle, file: 'idle-ffffffffffff.png' } } }), '');
  assert.equal(petPictureSource(custom, { states: { idle: { ...idle, url: 'file:///x.png' } } }), '');
  assert.equal(petPictureSource(custom, null), '');
});

// ---- Pinned above the message box -------------------------------------------------

/** The app window's composer card, in its CSS pixels. */
const COMPOSER = { x: 300, y: 600, width: 700, height: 120 };
/** With no island pill on screen, the line its bottom edge would take: its
 *  gap above the card (15-composer.css: 12px). */
const NO_ISLAND_LINE = DESKTOP_PET_ISLAND.gap;
/** Mixy's lowest drawn row of the 16x12 mascot (the art's visible feet). */
const { mascotCells, MIXY_AVATAR } = await import('../../../../src/runtime/shared/agent-avatar.mjs');
const MIXY_FEET_ROW = Math.max(...mascotCells(MIXY_AVATAR).map((cell) => cell.y));
/** The visible art's bottom for a sprite box: the 16x12 svg stands on the
 *  box's bottom, lowered by `gap` rows (desktop-pet.css --pet-feet-gap; the
 *  pet window sets 11 - feet row, checked in skin-companion.test.mjs). */
const artBottom = (box, size, feetRow = MIXY_FEET_ROW, gap = 11 - MIXY_FEET_ROW) =>
  box.bottom + (gap - (11 - feetRow)) * (size / 16);
/** The pet sprite box on screen for a window at `bounds` (at `shape`'s scale). */
const sprite = (bounds, shape = GEOMETRY) => {
  const bottom = bounds.y + bounds.height - shape.sprite.bottom;
  return {
    left: bounds.x + shape.sprite.left,
    right: bounds.x + shape.sprite.left + shape.sprite.size,
    bottom,
    centre: bottom - shape.sprite.size / 2,
  };
};
/** Where the pinned window goes for a composer in an app window at `content`:
 *  the sprite's feet on the island line, its right just inside the card. */
const pinnedAt = (composer = COMPOSER, content = APP_CONTENT, zoom = 1, shape = GEOMETRY) => ({
  x: Math.round(
    content.x + (composer.x + composer.width) * zoom - DESKTOP_PET_PIN_INSET - shape.sprite.left - shape.sprite.size
  ),
  y: Math.round(
    content.y + (composer.island ?? composer.y - NO_ISLAND_LINE) * zoom - (shape.window.height - shape.sprite.bottom)
  ),
});

test("pinned by default: the bot's feet on the island's bottom line, its right just inside the card", async () => {
  assert.equal(normalizeDesktopPetPrefs({}).pinned, true, 'absent: pinned');
  assert.equal(normalizeDesktopPetPrefs({ pinned: false }).pinned, false, 'an explicit unpin is kept');
  assert.deepEqual(DESKTOP_PET_ISLAND, { pillHeight: 34, gap: 12 });
  const { window } = await started({ composer: COMPOSER });
  assert.equal(window.shown, true);
  assert.deepEqual(position(window), Object.values(pinnedAt()));
  const box = sprite(window.bounds);
  assert.equal(
    artBottom(box, GEOMETRY.sprite.size),
    APP_CONTENT.y + COMPOSER.y - 12,
    "no island: feet where the pill's bottom would be"
  );
  assert.equal(box.right, APP_CONTENT.x + COMPOSER.x + COMPOSER.width - DESKTOP_PET_PIN_INSET, 'right inside the card');
  assert.deepEqual(pinnedPetPosition(APP_CONTENT, COMPOSER, 1, GEOMETRY), pinnedAt());
});

test("pinned: the bot's visible feet sit on the island pill's bottom edge, from the pill's real rect, at every scale", async () => {
  for (const scale of [50, 100, 150, 200]) {
    const shape = desktopPetGeometry(scale);
    const size = shape.sprite.size;
    const { window, app, pet } = await started({ prefs: { scale }, composer: COMPOSER });
    assert.deepEqual([window.bounds.width, window.bounds.height], [shape.window.width, shape.window.height]);
    // The pill shown above the card (its bottom edge reported, e.g. 588 = card top 600 - 12).
    for (const island of [588, 571, 480]) {
      app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, island });
      const box = sprite(window.bounds, shape);
      assert.ok(
        Math.abs(artBottom(box, size) - (APP_CONTENT.y + island)) <= 1,
        `${scale}%: feet on the pill's bottom at ${island}`
      );
      assert.equal(box.right, APP_CONTENT.x + COMPOSER.x + COMPOSER.width - DESKTOP_PET_PIN_INSET);
    }
    // No pill: the line the pill's bottom would take.
    app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, island: null });
    const box = sprite(window.bounds, shape);
    assert.ok(Math.abs(artBottom(box, size) - (APP_CONTENT.y + COMPOSER.y - 12)) <= 1, `${scale}%: no island`);
    // Zoomed app: the line scales with the app's CSS px.
    app.zoom = 1.25;
    app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, island: 588 });
    assert.ok(
      Math.abs(artBottom(sprite(window.bounds, shape), size) - (APP_CONTENT.y + 588 * 1.25)) <= 1,
      `${scale}%: zoom`
    );
    assert.equal(window.shows.length, 1);
    assert.deepEqual([window.bounds.width, window.bounds.height], [shape.window.width, shape.window.height]);
    pet.dispose();
  }
});

test('pinned: a wide island running under the bot puts its feet on the island top; a narrow one or none keeps the line', async () => {
  // The sprite box's right edge: the card's right less the inset (screen 1098 at zoom 1).
  const boxRight = COMPOSER.x + COMPOSER.width - DESKTOP_PET_PIN_INSET;
  for (const scale of [50, 100, 200]) {
    const shape = desktopPetGeometry(scale);
    const size = shape.sprite.size;
    const { window, app, pet } = await started({ prefs: { scale }, composer: COMPOSER });
    const feet = () => artBottom(sprite(window.bounds, shape), size);
    const emit = (left, right) =>
      app.webContents.emit(DESKTOP_PET_IPC.composer, {
        ...COMPOSER,
        island: 588,
        islandSpan: { left, right, top: 554 },
      });
    // Narrow, centred: clear of the box, feet on the pill's bottom as today.
    emit(500, 800);
    assert.ok(Math.abs(feet() - (APP_CONTENT.y + 588)) <= 1, `${scale}%: narrow island, baseline`);
    // Ends just short of the box's left edge: still beside it.
    emit(400, boxRight - size);
    assert.ok(Math.abs(feet() - (APP_CONTENT.y + 588)) <= 1, `${scale}%: touching is not overlapping`);
    // Wide: its right end runs under the box, the bot stands on its top (2px gap).
    emit(320, boxRight - size + 10);
    assert.ok(Math.abs(feet() - (APP_CONTENT.y + 554 - 2)) <= 1, `${scale}%: wide island, feet on its top`);
    assert.equal(
      sprite(window.bounds, shape).right,
      APP_CONTENT.x + boxRight - size + 10 - DESKTOP_PET_PIN_INSET,
      `${scale}%: at the island's right end, the card's inset inside it`
    );
    // An island reaching the card's right: the bot at the card's right as on the card.
    emit(320, COMPOSER.x + COMPOSER.width);
    assert.equal(sprite(window.bounds, shape).right, APP_CONTENT.x + boxRight, `${scale}%: never past the card`);
    // A short island under the box: the sprite stays over it, from its left end.
    emit(boxRight - size - 20, boxRight - size + 10);
    assert.equal(
      sprite(window.bounds, shape).left,
      APP_CONTENT.x + boxRight - size - 20 + DESKTOP_PET_PIN_INSET,
      `${scale}%: kept over a short island`
    );
    emit(320, boxRight - size + 10);
    // Same rect again: no move.
    const before = position(window);
    emit(320, boxRight - size + 10);
    assert.deepEqual(position(window), before, 'no jitter');
    // Zoomed: the overlap and the top in the app's CSS px.
    app.zoom = 1.25;
    app.webContents.emit(DESKTOP_PET_IPC.composer, {
      ...COMPOSER,
      island: 588,
      islandSpan: { left: 320, right: 1000, top: 554 },
    });
    assert.ok(Math.abs(feet() - (APP_CONTENT.y + 554 * 1.25 - 2)) <= 1, `${scale}%: zoomed`);
    app.zoom = 1;
    // No island: 12px above the card as today (a stale span is ignored).
    app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, island: null });
    assert.ok(Math.abs(feet() - (APP_CONTENT.y + COMPOSER.y - 12)) <= 1, `${scale}%: no island`);
    assert.equal(window.shows.length, 1);
    pet.dispose();
  }
  assert.deepEqual(
    requiredDesktopPetComposer({
      x: 1,
      y: 600,
      width: 700,
      height: 90,
      island: 588,
      islandSpan: { left: 9.6, right: 700.2, top: 553.7 },
    }),
    { x: 1, y: 600, width: 700, height: 90, island: 588, islandSpan: { left: 10, right: 700, top: 554 } }
  );
  for (const islandSpan of [
    { left: 0, right: 10 },
    { left: 10, right: 0, top: 554 },
    { left: 0, right: 10, top: 600 },
    'wide',
  ]) {
    assert.throws(
      () => requiredDesktopPetComposer({ x: 1, y: 600, width: 700, height: 90, island: 588, islandSpan }),
      /island/
    );
  }
});

test('pinned, the pet rides the composer: window move/resize/maximize, zoom, height change, minimise', async () => {
  const { window, app } = await started();
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const moved = { x: 300, y: 150, width: 1400, height: 820 };
  app.fire('move', { content: moved });
  assert.deepEqual(position(window), Object.values(pinnedAt(COMPOSER, moved)));
  const maximized = { x: 0, y: 0, width: 1920, height: 1040 };
  app.fire('maximize', { content: maximized });
  assert.deepEqual(position(window), Object.values(pinnedAt(COMPOSER, maximized)));
  app.fire('unmaximize', { content: moved });
  // The composer grows (several lines, attachments): the bot stays on the
  // island line above its top edge, up and then down again with it.
  for (const height of [120, 168, 240, 120]) {
    const card = { ...COMPOSER, y: COMPOSER.y + COMPOSER.height - height, height };
    app.webContents.emit(DESKTOP_PET_IPC.composer, card);
    assert.equal(sprite(window.bounds).bottom, moved.y + card.y - NO_ISLAND_LINE, `on the line at height ${height}`);
    assert.deepEqual(position(window), Object.values(pinnedAt(card, moved)));
  }
  // A side panel opens: the card narrows and moves; the pet follows its right end.
  const narrowed = { ...COMPOSER, x: 200, width: 560 };
  app.webContents.emit(DESKTOP_PET_IPC.composer, narrowed);
  assert.equal(sprite(window.bounds).right, moved.x + 760 - DESKTOP_PET_PIN_INSET);
  app.zoom = 1.25;
  app.fire('resize');
  assert.deepEqual(position(window), Object.values(pinnedAt(narrowed, moved, 1.25)));
  app.zoom = 1;
  app.fire('minimize', { minimized: true });
  assert.equal(window.shown, false);
  app.fire('restore', { minimized: false });
  assert.equal(window.shown, true);
  app.fire('hide', { visible: false });
  assert.equal(window.shown, false);
  app.fire('show', { visible: true });
  assert.equal(window.shown, true);
  // Near the top of the work area: still on screen.
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, y: -80 });
  assert.equal(window.bounds.y, 0);
  const near = position(window);
  app.webContents.emit(DESKTOP_PET_IPC.composer, { x: 'a', y: 0, width: 1, height: 1 });
  assert.deepEqual(position(window), near, 'a malformed rect is dropped');
  app.fire('closed');
  assert.equal(window.destroyed, true, 'the app window closing takes the pet with it');
});

test('pinned near the right edge, the pet and its quick message stay on screen', async () => {
  const { window, app } = await started();
  app.fire('move', { content: { x: 900, y: 100, width: 1020, height: 800 } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, { x: 300, y: 600, width: 712, height: 120 });
  assert.equal(window.bounds.x + DESKTOP_PET_CORE_WIDTH, 1920, 'as far right as the quick message allows');
  assert.ok(sprite(window.bounds).right < 900 + 1012, 'over the card');
});

test("pinned at the screen's right edge, the pet tells its menu how much of the window is on screen", async () => {
  const { window, app } = await started();
  const menuNeed = DESKTOP_PET_SPRITE.left + DESKTOP_PET_SPRITE.size + 8 + 200 + 4;
  assert.equal(window.webContents.lastView().screenRight, SIZE.width, 'mid-screen: the whole window');
  app.fire('move', { content: { x: 900, y: 100, width: 1020, height: 800 } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, { x: 300, y: 600, width: 712, height: 120 });
  const edge = window.webContents.lastView().screenRight;
  assert.equal(edge, 1920 - window.bounds.x, 'pushed live as the pinned window moves');
  assert.ok(edge < menuNeed, 'the right-hand menu would run off screen here');
  assert.ok(edge >= DESKTOP_PET_CORE_WIDTH, 'the left-hand menu room is on screen');
  assert.deepEqual([window.bounds.width, window.bounds.height], [SIZE.width, SIZE.height], 'never resized');
  app.fire('move', { content: { x: 0, y: 0, width: 1400, height: 900 } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  assert.equal(window.webContents.lastView().screenRight, SIZE.width, 'back mid-screen: the right again');
});

test("pinned at the app window's right edge, the bubble's span ends at the app's right, at every scale", async () => {
  const appRight = APP_CONTENT.x + APP_CONTENT.width;
  for (const scale of [50, 100, 200]) {
    const { window, app } = await started({ prefs: { scale } });
    // The card runs to the window's right edge: the pet window extends past it.
    app.webContents.emit(DESKTOP_PET_IPC.composer, { x: 300, y: 600, width: APP_CONTENT.width - 300, height: 120 });
    const width = desktopPetGeometry(scale).window.width;
    assert.ok(window.bounds.x + width > appRight, `${scale}%: the pet window passes the app's right edge`);
    const span = window.webContents.lastView().bubbleSpan;
    assert.equal(window.bounds.x + span.right, appRight, `${scale}%: the span ends at the app's right`);
    assert.equal(span.left, Math.max(0, APP_CONTENT.x - window.bounds.x));
  }
});

test('free, the span is the app content while the bot stands over it, else the work area; resent as the app moves', async () => {
  const { window, app } = await started({ prefs: { ...FREE, positions: { 1: { x: 1000, y: 300 } } } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const at = window.bounds.x;
  assert.deepEqual(
    window.webContents.lastView().bubbleSpan,
    {
      left: 0,
      right: APP_CONTENT.x + APP_CONTENT.width - at,
    },
    'over the app window: its content'
  );
  // The app window moves away from under it: the work area (the whole window here).
  app.fire('move', { content: { x: 0, y: 0, width: 600, height: 500 } });
  assert.deepEqual(window.webContents.lastView().bubbleSpan, { left: 0, right: SIZE.width });
  // Saved past the screen's right edge (clamped there): within the work area.
  const edge = await started({ prefs: { ...FREE, positions: { 1: { x: 5000, y: 300 } } } });
  edge.app.fire('move', { content: { x: 0, y: 0, width: 600, height: 500 } });
  edge.app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const span = edge.window.webContents.lastView().bubbleSpan;
  assert.ok(edge.window.bounds.x + span.right <= 1920, 'inside the work area');
  assert.ok(edge.window.bounds.x + span.left >= 0);
});

test('pinned, a hidden app window at start keeps the pet hidden until it shows', async () => {
  const context = setup();
  context.app.visible = false;
  context.pet.start();
  context.app.webContents.emit(DESKTOP_PET_IPC.publish, BOOT_STATE);
  context.app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  await tick();
  assert.equal(context.windows[0].shown, false);
  context.app.fire('show', { visible: true });
  assert.equal(context.windows[0].shown, true);
});

test('pinned, the pet cannot be dragged or nudged; unpinned first, it can, and the spot is saved', async () => {
  const { pet, window, app, stored } = await started();
  const contents = window.webContents;
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const at = Object.values(pinnedAt());
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 500, screenY: 500 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'move', screenX: 400, screenY: 450 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 400, screenY: 450 });
  contents.emit(DESKTOP_PET_IPC.nudge, 8, 0);
  assert.deepEqual(position(window), at, 'not moved');
  assert.equal(stored().pinned, true, 'still pinned');
  assert.deepEqual(stored().positions, {});
  // Unpin from the menu: it stays where it stands, as its free spot.
  command(window, 'pin');
  assert.equal(stored().pinned, false);
  assert.equal(contents.lastView().pinned, false);
  assert.deepEqual(stored().positions, { 1: pinnedAt() });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 500, screenY: 500 });
  contents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 400, screenY: 450 });
  const dropped = { x: at[0] - 100, y: at[1] - 50 };
  assert.deepEqual(position(window), [dropped.x, dropped.y]);
  assert.deepEqual(stored().positions, { 1: dropped });
  app.fire('move', { content: { ...APP_CONTENT, x: 500 } });
  assert.deepEqual(position(window), [dropped.x, dropped.y], 'a free pet does not follow the composer');
  pet.dispose();
  const restarted = await started({ prefs: stored() });
  restarted.app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  assert.deepEqual(position(restarted.window), [dropped.x, dropped.y], 'free, at the saved spot after restart');
});

test('Reset position re-pins; Settings and the menu set the same options and both hear every change', async () => {
  const { window, app, stored } = await started({ prefs: { ...FREE, positions: { 1: { x: 40, y: 40 } } } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  assert.deepEqual(position(window), [40, 40], 'free: the saved spot');
  command(window, 'reset');
  assert.equal(stored().pinned, true);
  assert.deepEqual(stored().positions, {});
  assert.deepEqual(position(window), Object.values(pinnedAt()));
  assert.equal(lastConfig(app).pinned, true, 'Settings shows it pinned');
  // Settings → Bots unpins and collapses; the pet's menu shows the same.
  let config = await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinned', false);
  assert.equal(config.pinned, false);
  config = await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'collapsed', true);
  assert.deepEqual(config, {
    enabled: true,
    pinned: false,
    pinnedHere: false,
    onScreen: false,
    keepAbove: false,
    collapsed: true,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
  });
  assert.equal(window.webContents.lastView().collapsed, true);
  assert.equal(window.webContents.lastView().pinned, false);
  // The menu's collapse toggles it back; Settings hears it.
  command(window, 'collapse');
  assert.equal(lastConfig(app).collapsed, false);
  // Settings' Reset position re-pins.
  config = await app.webContents.invoke(DESKTOP_PET_IPC.resetPosition);
  assert.equal(config.pinned, true);
  assert.deepEqual(position(window), Object.values(pinnedAt()));
  await assert.rejects(async () => app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'enabled', false));
  await assert.rejects(async () => app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinned', 'yes'));
  command(window, 'open');
  command(window, 'evil');
  assert.equal(stored().pinned, true);
});

test('"Pin here" locks the bot where it stands: no drag or nudge, kept across a restart, exclusive with the composer pin, cleared by Reset', async () => {
  const { pet, window, app, stored } = await started({ prefs: { ...FREE, positions: { 1: { x: 40, y: 40 } } } });
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const contents = window.webContents;
  const drag = (from, to) => {
    contents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: from, screenY: from });
    contents.emit(DESKTOP_PET_IPC.drag, { phase: 'move', screenX: to, screenY: to });
    contents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: to, screenY: to });
  };
  // Free: it drags (today's behaviour).
  drag(500, 520);
  assert.deepEqual(position(window), [60, 60]);
  command(window, 'pin-here');
  assert.equal(stored().pinnedHere, true);
  assert.equal(stored().pinned, false);
  assert.deepEqual(stored().positions, { 1: { x: 60, y: 60 } }, 'its spot is saved');
  assert.equal(contents.lastView().pinnedHere, true, 'the menu shows it checked');
  assert.equal(lastConfig(app).pinnedHere, true, 'Settings hears it');
  drag(500, 400);
  contents.emit(DESKTOP_PET_IPC.nudge, 8, 0);
  assert.deepEqual(position(window), [60, 60], 'drag and nudge are ignored');
  app.fire('move', { content: { ...APP_CONTENT, x: 500 } });
  assert.deepEqual(position(window), [460, 60], 'it moves with the app window');
  app.fire('move', { content: { ...APP_CONTENT } });
  assert.deepEqual(position(window), [60, 60]);
  // Restart: still locked at the same spot.
  pet.dispose();
  const again = await started({ prefs: stored() });
  again.app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  assert.deepEqual(position(again.window), [60, 60], 'at its spot after restart');
  assert.equal(again.pet.config().pinnedHere, true);
  again.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 0, screenY: 0 });
  again.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: 90, screenY: 90 });
  assert.deepEqual(position(again.window), [60, 60], 'still locked after restart');
  // Pin above the message box turns it off; Pin here turns that off again.
  command(again.window, 'pin');
  assert.deepEqual([again.stored().pinned, again.stored().pinnedHere], [true, false]);
  assert.deepEqual(position(again.window), Object.values(pinnedAt()));
  let config = await again.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinnedHere', true);
  assert.deepEqual([config.pinned, config.pinnedHere], [false, true], 'Settings: Pin here unpins the composer pin');
  assert.deepEqual(position(again.window), Object.values(pinnedAt()), 'locked where it stood');
  // Both off: free and draggable.
  config = await again.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinnedHere', false);
  assert.deepEqual([config.pinned, config.pinnedHere], [false, false]);
  const free = position(again.window);
  again.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'start', screenX: 0, screenY: 0 });
  again.window.webContents.emit(DESKTOP_PET_IPC.drag, { phase: 'end', screenX: -10, screenY: -10 });
  assert.deepEqual(position(again.window), [free[0] - 10, free[1] - 10]);
  // Reset position clears it.
  command(again.window, 'pin-here');
  assert.equal(again.stored().pinnedHere, true);
  command(again.window, 'reset');
  assert.deepEqual([again.stored().pinned, again.stored().pinnedHere], [true, false]);
  await assert.rejects(async () => again.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinnedHere', 1), /boolean/);
  await assert.rejects(async () => again.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'here', true), /option/);
});

test('"Pin here" is held against the app window\'s composer card: moves with it, keeps its nearest-corner offset, hides with it, survives a restart', async () => {
  // Near the composer card's bottom-right corner (card 400..1100 x 700..820 on the screen).
  const spot = { x: 900, y: 520 };
  const { pet, window, app, stored } = await started({ prefs: { ...FREE, positions: { 1: spot } } });
  assert.deepEqual(position(window), [900, 520]);
  command(window, 'pin-here');
  assert.deepEqual(
    stored().hereAnchor,
    { right: true, bottom: true, dx: 200, dy: 300, composer: true },
    'from the right/bottom'
  );
  // Moved: by the same delta.
  app.fire('move', { content: { ...APP_CONTENT, x: 160, y: 80 } });
  assert.deepEqual(position(window), [960, 500]);
  // Resized (the card keeps its CSS box): the right/bottom offsets are kept.
  app.fire('resize', { content: { x: 160, y: 80, width: 1400, height: 900 } });
  assert.deepEqual(position(window), [160 + 300 + 700 - 200, 80 + 600 + 120 - 300]);
  // Maximised to the work area: the same corner offsets.
  app.fire('maximize', { content: { x: 0, y: 0, width: 1920, height: 1040 } });
  assert.deepEqual(position(window), [800, 420]);
  // Minimised: hidden; restored: back, at its spot.
  app.fire('minimize', { minimized: true });
  assert.equal(window.shown, false);
  app.fire('restore', { minimized: false });
  assert.equal(window.shown, true);
  assert.deepEqual(position(window), [800, 420]);
  app.fire('hide', { visible: false });
  assert.equal(window.shown, false);
  app.fire('show', { visible: true });
  assert.equal(window.shown, true);
  // A window too small for the offset: the sprite stays inside its content.
  app.fire('resize', { content: { x: 0, y: 0, width: 300, height: 300 } });
  const { sprite: box, window: room } = GEOMETRY;
  assert.ok(window.bounds.x + box.left >= 0 && window.bounds.x + box.left + box.size <= 300, 'inside, x');
  // (Its window flipped: no room above it on the screen's top.)
  const feet = window.webContents.lastView().flipped
    ? window.bounds.y + box.bottom + box.size
    : window.bounds.y + room.height - box.bottom;
  assert.ok(feet <= 300 && feet - box.size >= 0, 'inside, y');
  // Restart with the window back at its first place: the same anchored spot.
  pet.dispose();
  const again = await started({ prefs: stored() });
  assert.deepEqual(again.stored().hereAnchor, { right: true, bottom: true, dx: 200, dy: 300, composer: true });
  assert.deepEqual(position(again.window), [900, 520]);
  again.app.fire('move', { content: { ...APP_CONTENT, x: 0 } });
  assert.deepEqual(position(again.window), [800, 520]);
  // Reset position clears it.
  command(again.window, 'reset');
  assert.equal(again.stored().hereAnchor, null);
  // An older absolute "Pin here" spot: anchored to the card it first meets.
  const older = await started({ prefs: { ...FREE, pinnedHere: true, positions: { 1: { x: 40, y: 40 } } } });
  assert.deepEqual(older.stored().hereAnchor, { right: false, bottom: false, dx: -360, dy: -660, composer: true });
  assert.deepEqual(position(older.window), [40, 40]);
  older.app.fire('move', { content: { ...APP_CONTENT, x: 300 } });
  assert.deepEqual(position(older.window), [240, 40]);
  // Turned off: the anchor goes.
  command(older.window, 'pin-here');
  assert.equal(older.stored().hereAnchor, null);
  assert.equal(
    normalizeDesktopPetPrefs({ pinned: false, pinnedHere: true, hereAnchor: { right: 1 } }).hereAnchor,
    null
  );
});

test('"Pin here" is held against the composer card: it follows the card when the side dock moves it, with no window move', async () => {
  const spot = { x: 900, y: 520 };
  const { window, app, stored } = await started({ prefs: { ...FREE, positions: { 1: spot } }, composer: COMPOSER });
  command(window, 'pin-here');
  assert.equal(stored().hereAnchor.composer, true, 'anchored to the card');
  assert.deepEqual(position(window), [900, 520]);
  const send = (change) => app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, ...change });
  // The card slides left (a dock opened) and right again: the bot goes with it.
  send({ x: COMPOSER.x - 150 });
  assert.deepEqual(position(window), [750, 520]);
  send({ x: COMPOSER.x + 50 });
  assert.deepEqual(position(window), [950, 520]);
  send({});
  assert.deepEqual(position(window), [900, 520]);
  // A spot saved against the window (an older one) moves onto the card where it stands.
  const older = await started({
    prefs: { ...FREE, pinnedHere: true, positions: { 1: spot } },
    composer: null,
  });
  assert.equal(older.stored().hereAnchor?.composer, undefined, 'no card yet: against the window');
  older.app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  assert.equal(older.stored().hereAnchor.composer, true);
  assert.deepEqual(position(older.window), [900, 520], 'where it stood');
  older.app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, x: COMPOSER.x - 150 });
  assert.deepEqual(position(older.window), [750, 520], 'then follows the card');
});

test('the over-transcript flag follows the pinned bot over the transcript column, sent once per change', async () => {
  const { window, app } = await started({ composer: COMPOSER });
  const flags = () =>
    app.webContents.sent
      .filter(([channel]) => channel === DESKTOP_PET_IPC.appLayout)
      .map(([, layout]) => layout.overTranscript);
  // The column above the card, its last row ending 24px above the region (CSS px).
  const column = { left: 300, right: 1000, bottom: 530 };
  const send = (change) =>
    app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, transcript: column, ...change });
  // Wide window: the bot on the island's baseline stays below the last line.
  send({ island: 588, islandSpan: { left: 500, right: 800, top: 554 } });
  assert.equal(flags().at(-1), false);
  // Narrow: a wide island lifts it onto its top, up into the column.
  send({ island: 588, islandSpan: { left: 320, right: 1000, top: 554 } });
  assert.equal(flags().at(-1), true, 'over the column');
  const count = flags().length;
  send({ island: 588, islandSpan: { left: 320, right: 1000, top: 554 } });
  app.fire('move');
  assert.equal(flags().length, count, 'unchanged: not sent again');
  // A column that ends left of the bot: clear.
  send({ island: 588, islandSpan: { left: 320, right: 1000, top: 554 }, transcript: { ...column, right: 700 } });
  assert.equal(flags().at(-1), false, 'beside the column');
  send({ island: 588, islandSpan: { left: 320, right: 1000, top: 554 } });
  assert.equal(flags().at(-1), true);
  // Hidden with the app window, unpinned, or off: no flag.
  app.fire('minimize', { minimized: true });
  assert.equal(flags().at(-1), false, 'hidden');
  app.fire('restore', { minimized: false });
  assert.equal(flags().at(-1), true);
  command(window, 'pin');
  assert.equal(flags().at(-1), false, 'unpinned');
  command(window, 'pin');
  assert.equal(flags().at(-1), true);
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, false);
  assert.equal(flags().at(-1), false, 'overlay off');
  // The column is validated with the card.
  const card = { x: 1, y: 600, width: 700, height: 90 };
  assert.deepEqual(requiredDesktopPetComposer({ ...card, transcript: { left: 0.4, right: 700.6, bottom: 529.5 } }), {
    ...card,
    island: null,
    transcript: { left: 0, right: 701, bottom: 530 },
  });
  for (const transcript of [{ left: 0, right: 10 }, { left: 10, right: 0, bottom: 1 }, 'wide']) {
    assert.throws(() => requiredDesktopPetComposer({ ...card, transcript }), /transcript/);
  }
});

test("the island reserve: the pinned bot's visible art at its scale, look and zoom while pinned above the message box, else 0", async () => {
  const { window, app } = await started({ composer: COMPOSER });
  window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 120, width: 120, height: 84 });
  const reserves = () =>
    app.webContents.sent
      .filter(([channel]) => channel === DESKTOP_PET_IPC.appLayout)
      .map(([, layout]) => layout.islandReserve);
  // No look yet: the whole 56px box + 2px pin inset + 4px clearance.
  assert.equal(reserves().at(-1), 62);
  const look = (id, avatar, room = false) =>
    app.webContents.emit(DESKTOP_PET_IPC.publish, {
      ...STATE,
      face: { room, members: [{ id, name: 'Bot', avatar }] },
    });
  // Mixy's own look: drawn from column 1 of 16 (3.5px clear at 56px): 52.5 + 2, up, + 4.
  assert.equal(Math.min(...mascotCells(MIXY_AVATAR).map((cell) => cell.x)), 1);
  look(MIXY_AGENT_ID, null);
  assert.equal(reserves().at(-1), 59);
  // A look drawn from column 3 (10.5px clear): 45.5 + 2, up, + 4.
  const corgi = { kind: 'mascot', species: 'corgi', accessory: 'none', expression: 'calm', color: '#e6e6e6' };
  assert.equal(Math.min(...mascotCells(corgi).map((cell) => cell.x)), 3);
  look('scout', corgi);
  assert.equal(reserves().at(-1), 52, 'another look');
  look('scout', corgi, true);
  assert.equal(reserves().at(-1), 62, "a room's stack: the whole box");
  look(MIXY_AGENT_ID, null);
  assert.equal(reserves().at(-1), 59);
  // Showing or not at this moment does not move it: no island reflow.
  const count = reserves().length;
  app.fire('minimize', { minimized: true });
  app.fire('restore', { minimized: false });
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: false, rects: [{ x: 0, y: 0, width: 1400, height: 900 }] });
  assert.equal(window.shown, true, 'a menu over it cuts it, never hides it');
  assert.equal(window.webContents.lastView().cutouts.length, 1);
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: true, rects: [] });
  assert.equal(window.shown, false, 'under a backdrop modal');
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: false, rects: [] });
  app.fire('move');
  assert.equal(reserves().length, count, 'not sent again');
  // In the app's CSS px.
  app.zoom = 2;
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, width: 400 });
  assert.equal(reserves().at(-1), 32, '(52.5 + 2) / 2, rounded up, + 4');
  app.zoom = 1;
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER });
  assert.equal(reserves().at(-1), 59);
  // Follows the scale, with no 0 while the window is replaced.
  const before = reserves().length;
  await app.webContents.invoke(DESKTOP_PET_IPC.setScale, 200);
  await tick();
  assert.deepEqual(reserves().slice(before), [111], '112 - 7 + 2 + 4');
  await app.webContents.invoke(DESKTOP_PET_IPC.setScale, 50);
  await tick();
  assert.equal(reserves().at(-1), 33, '28 - 1.75 + 2, up, + 4');
  // Unpinned (free or pinned here), no card, or off: none.
  await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinned', false);
  assert.equal(reserves().at(-1), 0, 'free');
  await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinnedHere', true);
  assert.equal(reserves().at(-1), 0, 'pinned here');
  await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinned', true);
  assert.equal(reserves().at(-1), 33);
  app.webContents.emit(DESKTOP_PET_IPC.composer, null);
  assert.equal(reserves().at(-1), 0, 'no card');
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER });
  assert.equal(reserves().at(-1), 33);
  await app.webContents.invoke(DESKTOP_PET_IPC.setEnabled, false);
  assert.equal(reserves().at(-1), 0, 'overlay off');
  // The wire form, as the preload reads it.
  assert.deepEqual(desktopPetAppLayout({ overTranscript: true, islandReserve: 65.6 }), {
    overTranscript: true,
    islandReserve: 66,
  });
  for (const bad of [null, 'x', { overTranscript: 'yes', islandReserve: -3 }, { islandReserve: Number.NaN }]) {
    assert.deepEqual(desktopPetAppLayout(bad), { overTranscript: false, islandReserve: 0 });
  }
  assert.equal(desktopPetAppLayout({ islandReserve: 1e9 }).islandReserve, 10_000);
});

test('showsSession: the followed session while the overlay is on screen with its bubble open', async () => {
  const { pet, window, app } = await started({ composer: COMPOSER });
  app.webContents.emit(DESKTOP_PET_IPC.publish, STATE);
  assert.equal(pet.showsSession(MIXY), true);
  assert.equal(pet.showsSession('other-session'), false, 'another session still notifies');
  assert.equal(pet.showsSession(''), false);
  app.fire('minimize', { minimized: true });
  assert.equal(pet.showsSession(MIXY), false, 'hidden with the app window');
  app.fire('restore', { minimized: false });
  assert.equal(pet.showsSession(MIXY), true);
  command(window, 'collapse');
  assert.equal(pet.showsSession(MIXY), false, 'collapsed bubble');
  command(window, 'collapse');
  pet.setEnabled(false);
  assert.equal(pet.showsSession(MIXY), false, 'overlay off');
});

test("the menu's Settings item brings the app window to front on Settings → Bots; its Size row sets the size", async () => {
  const { app, windows, calls, stored } = await started({ composer: COMPOSER });
  command(windows[0], 'settings');
  assert.deepEqual(calls.open, [''], 'the app window to front (no session opened)');
  assert.deepEqual(app.webContents.sent.at(-1), [DESKTOP_PET_IPC.openSettings]);
  // The Size row's choice, given as the menu closes: validated, replaces the window.
  windows[0].webContents.emit(DESKTOP_PET_IPC.scale, 155);
  windows[0].webContents.emit(DESKTOP_PET_IPC.scale, '150');
  assert.equal(stored().scale, 100, 'an invalid size is dropped');
  windows[0].webContents.emit(DESKTOP_PET_IPC.scale, 150);
  await tick();
  assert.equal(stored().scale, 150);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows.at(-1).webContents.lastView().scale, 150);
  assert.equal(lastConfig(app).scale, 150, 'Settings hears it');
});

test('the pet window is created hidden and shows only after its renderer drew the first frame', async () => {
  const { window, app } = await started({ paint: false });
  assert.ok(window, 'created');
  assert.equal(window.shown, false, 'loaded and the composer is there, but nothing drawn yet: hidden');
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...BOOT_COMPOSER, y: 560 });
  assert.equal(window.shown, false);
  const pinned = { ...window.bounds };
  window.webContents.emit(DESKTOP_PET_IPC.painted);
  assert.equal(window.shown, true, 'painted: shown');
  assert.deepEqual(window.shows, [pinned], 'once, already at its spot, no resize after');
  window.webContents.emit(DESKTOP_PET_IPC.painted);
  assert.equal(window.shows.length, 1);
});

// The real BrowserWindow options live in index.ts next to Electron's imports, so
// the factory cannot run under test; these are the options with no other check.
test('the pet BrowserWindow is created hidden, transparent and IME-activatable', async () => {
  const { readFile } = await import('node:fs/promises');
  const index = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const start = index.indexOf('function createDesktopPetController');
  const options = index.slice(start, index.indexOf('webPreferences', start));
  assert.match(options, /show: false/);
  assert.match(options, /transparent: true/);
  assert.match(options, /backgroundColor: '#00000000'/);
  // focusable: false then setFocusable(true) left the IME composing outside the quick message.
  assert.doesNotMatch(options, /focusable: false/);
  const module = await readFile(new URL('./desktop-pet-window.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /\.setFocusable\(|setBackgroundColor/);
  assert.match(module, /showInactive\(\)/);
});

test('click-through with mouse forwarding is armed only after the page loaded (Windows forwards to its child window)', async () => {
  let release;
  const pageLoaded = new Promise((resolve) => {
    release = resolve;
  });
  const { pet, windows, app } = setup({ pageLoaded });
  pet.start();
  app.webContents.emit(DESKTOP_PET_IPC.composer, BOOT_COMPOSER);
  await tick();
  const [window] = windows;
  // Electron's forwarding (Windows) posts the moves to the page's child
  // window, which exists only once the page has loaded: armed earlier, no
  // move ever reaches the pet and the bot stays click-through.
  assert.equal(window.ignore, null, 'not armed while the page loads');
  release();
  await tick();
  await tick();
  assert.deepEqual(window.ignore, { ignore: true, forward: true }, 'armed once loaded');
  pet.dispose();
});

test('the window never resizes: the menu fits beside the pet, so right-click cannot flash the sprite', async () => {
  const { window, app } = await started();
  assert.equal('menuHeight' in DESKTOP_PET_IPC, false, 'no channel asks main to grow the window');
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  const resting = sprite(window.bounds);
  // Opening the menu takes focus and reports a wider drawn area; neither
  // moves, resizes or hides the window.
  window.webContents.emit(DESKTOP_PET_IPC.focusInput, true);
  window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 4, width: 280, height: 204 });
  assert.deepEqual(sprite(window.bounds), resting);
  assert.equal(window.shown, true);
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, y: 560, height: 160 });
  assert.deepEqual([window.bounds.width, window.bounds.height], [SIZE.width, SIZE.height]);
  assert.equal(sprite(window.bounds).bottom, APP_CONTENT.y + 560 - NO_ISLAND_LINE);
});

test("one of the app's own menus or tooltips over the pet is cut out of it (window px), never hides it", async () => {
  const { window, app } = await started();
  const layers = (...rects) => app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: false, rects });
  const cuts = () => window.webContents.lastView().cutouts;
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  // What the pet draws: the sprite and a small bubble (window px).
  window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 120, width: 120, height: 84 });
  assert.deepEqual(cuts(), []);
  // The window's top-left in the app's CSS px (zoom 1).
  const left = window.bounds.x - APP_CONTENT.x;
  const top = window.bounds.y - APP_CONTENT.y;
  // A menu off the pet window: nothing to cut.
  layers({ x: 10, y: 10, width: 50, height: 50 });
  assert.equal(window.shown, true);
  assert.deepEqual(cuts(), []);
  // The model menu opens up from the composer over the pet: shown, that part
  // cut out (clipped to the window).
  const menu = { x: left + 8, y: top - 30, width: 260, height: 220 };
  layers({ x: 10, y: 10, width: 50, height: 50 }, menu);
  assert.equal(window.shown, true, 'the pet stays, behind the menu');
  assert.deepEqual(cuts(), [{ x: 8, y: 0, width: 260, height: 190 }]);
  // The composer grows while the menu is open: still shown, still placed, the cut follows the window.
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, y: 560, height: 160 });
  assert.equal(window.shown, true);
  assert.equal(sprite(window.bounds).bottom, APP_CONTENT.y + 560 - NO_ISLAND_LINE);
  const shift = window.bounds.y - APP_CONTENT.y - top;
  const cutTop = Math.max(0, -30 - shift);
  assert.notEqual(shift, 0, 'the window moved');
  assert.deepEqual(cuts(), [{ x: 8, y: cutTop, width: 260, height: 190 - shift - cutTop }]);
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  // A tooltip touching the sprite: shown, a 4px cut.
  layers({ x: left + 227, y: top + 203, width: 4, height: 4 });
  assert.equal(window.shown, true);
  assert.deepEqual(cuts(), [{ x: 227, y: 203, width: 4, height: 4 }]);
  // It closes: the cut-outs clear.
  layers();
  assert.deepEqual(cuts(), []);
  layers(menu);
  app.webContents.emit(DESKTOP_PET_IPC.layers, 'all');
  app.webContents.emit(DESKTOP_PET_IPC.layers, [menu]);
  assert.deepEqual(
    cuts(),
    [{ x: 8, y: 0, width: 260, height: 190 }],
    'a malformed (or old-shape) report changes nothing'
  );
  layers();
  assert.equal(window.shown, true);
  assert.deepEqual(cuts(), []);
});

test('at 200% zoom an app menu is cut out at its screen place in the pet window', async () => {
  const { window, app } = await started();
  app.zoom = 2;
  app.webContents.emit(DESKTOP_PET_IPC.composer, { ...COMPOSER, x: 100, y: 300, width: 350, height: 60 });
  window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 120, width: 120, height: 84 });
  // A 100×50 CSS px menu about 20px right of and 10px below the window's top-left.
  const x = Math.round((window.bounds.x - APP_CONTENT.x) / 2) + 10;
  const y = Math.round((window.bounds.y - APP_CONTENT.y) / 2) + 5;
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: false, rects: [{ x, y, width: 100, height: 50 }] });
  assert.equal(window.shown, true);
  // Screen px = content origin + CSS px × 2; window px = screen − the window's top-left.
  assert.deepEqual(window.webContents.lastView().cutouts, [
    { x: APP_CONTENT.x + 2 * x - window.bounds.x, y: APP_CONTENT.y + 2 * y - window.bounds.y, width: 200, height: 100 },
  ]);
  // A backdrop modal: hidden, as before.
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: true, rects: [{ x, y, width: 100, height: 50 }] });
  assert.equal(window.shown, false);
  app.webContents.emit(DESKTOP_PET_IPC.layers, { backdrop: false, rects: [] });
  assert.equal(window.shown, true);
  assert.deepEqual(window.webContents.lastView().cutouts, []);
});

test("an app modal's backdrop hides the pet wherever it overlaps the app window; the quick message survives the hide", async () => {
  // The publisher flags a backdrop modal (the dialog itself may be a rect too).
  const BACKDROP = { backdrop: true, rects: [] };
  const NONE = { backdrop: false, rects: [] };
  const { window, app } = await started();
  app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 120, width: 120, height: 84 });
  assert.equal(window.shown, true);
  // The quick message is open (the window has focus) when a modal opens.
  window.webContents.emit(DESKTOP_PET_IPC.focusInput, true);
  const sent = window.webContents.sent.length;
  app.webContents.emit(DESKTOP_PET_IPC.layers, BACKDROP);
  assert.equal(window.shown, false, 'pinned on the composer: under the dim');
  window.events.emit('blur');
  assert.ok(
    !window.webContents.sent.slice(sent).some(([channel]) => channel === DESKTOP_PET_IPC.blurred),
    'hiding is not the user leaving: the quick message stays open'
  );
  // A nested modal closes: the outer one's backdrop still covers.
  app.webContents.emit(DESKTOP_PET_IPC.layers, {
    backdrop: true,
    rects: [{ x: 300, y: 200, width: 400, height: 300 }],
  });
  app.webContents.emit(DESKTOP_PET_IPC.layers, BACKDROP);
  assert.equal(window.shown, false);
  // The last one closes: back.
  app.webContents.emit(DESKTOP_PET_IPC.layers, NONE);
  assert.equal(window.shown, true);
  // A real blur (the user clicked elsewhere) still closes it.
  window.events.emit('blur');
  assert.deepEqual(window.webContents.sent.at(-1), [DESKTOP_PET_IPC.blurred]);
  // Off the app window, a modal there leaves the pet alone.
  const free = await started({ prefs: { ...FREE, positions: { 1: { x: 1500, y: 300 } } } });
  free.app.webContents.emit(DESKTOP_PET_IPC.composer, COMPOSER);
  free.window.webContents.emit(DESKTOP_PET_IPC.area, { x: 108, y: 120, width: 120, height: 84 });
  assert.equal(free.window.shown, true);
  free.app.webContents.emit(DESKTOP_PET_IPC.layers, BACKDROP);
  assert.equal(free.window.shown, true, 'not over the app window: stays');
});

// ---- Chat --------------------------------------------------------------------------

test('the published state and theme reach the pet window; the quick message goes through the send path once', async () => {
  const { window, app, calls } = await started({ prefs: { enabled: true } });
  app.webContents.emit(DESKTOP_PET_IPC.publish, STATE);
  const base = {
    ...STATE,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    keepAbove: false,
    pinned: true,
    pinnedHere: false,
    onScreen: false,
    scale: 100,
    flipped: false,
    theme: null,
    visible: true,
    screenRight: Math.min(SIZE.width, 1920 - window.bounds.x),
    bubbleSpan: {
      left: Math.max(0, APP_CONTENT.x - window.bounds.x),
      right: Math.min(SIZE.width, APP_CONTENT.x + APP_CONTENT.width - window.bounds.x),
    },
    cutouts: [],
  };
  assert.deepEqual(window.webContents.lastView(), base);
  const theme = { scheme: 'light', vars: { '--mx-composer-surface': '#ffffff', '--mx-text': 'rgb(20, 20, 20)' } };
  app.webContents.emit(DESKTOP_PET_IPC.theme, theme);
  assert.deepEqual(window.webContents.lastView().theme, theme, 'the app theme is relayed');
  app.webContents.emit(DESKTOP_PET_IPC.theme, { scheme: 'light', vars: { '--mx-text': 'url(x)' } });
  assert.deepEqual(window.webContents.lastView().theme, theme, 'an unsafe theme is dropped');
  app.webContents.emit(DESKTOP_PET_IPC.publish, { ...STATE, sessionId: '../etc' });
  window.webContents.emit(DESKTOP_PET_IPC.ready);
  assert.deepEqual(window.webContents.lastView(), { ...base, theme });
  assert.equal(await window.webContents.invoke(DESKTOP_PET_IPC.send, '  ship it  '), true);
  assert.deepEqual(calls.submit, [[MIXY, 'ship it']]);
  await assert.rejects(async () => window.webContents.invoke(DESKTOP_PET_IPC.send, '   '));
  assert.equal(calls.submit.length, 1);
  window.webContents.emit(DESKTOP_PET_IPC.open);
  command(window, 'open');
  assert.deepEqual(calls.open, [MIXY, MIXY]);
  app.webContents.emit(DESKTOP_PET_IPC.publish, { ...STATE, sessionId: '' });
  assert.equal(await window.webContents.invoke(DESKTOP_PET_IPC.send, 'hello'), false);
  assert.equal(calls.submit.length, 1);
  window.webContents.emit(DESKTOP_PET_IPC.focusInput, true);
  assert.equal(window.focused, true);
  window.events.emit('blur');
  assert.deepEqual(window.webContents.sent.at(-1), [DESKTOP_PET_IPC.blurred]);
  window.webContents.emit(DESKTOP_PET_IPC.interactive, true);
  assert.deepEqual(window.ignore, { ignore: false, forward: true });
});

test('a reply read in the overlay marks its chat read: only the shown reply, only with a chat', async () => {
  const { window, app, calls } = await started();
  window.webContents.emit(DESKTOP_PET_IPC.read, 'turn-1');
  assert.deepEqual(calls.read, [], 'no reply shown yet');
  app.webContents.emit(DESKTOP_PET_IPC.publish, STATE);
  window.webContents.emit(DESKTOP_PET_IPC.read, 'turn-0');
  assert.deepEqual(calls.read, [], 'an older reply marks nothing');
  window.webContents.emit(DESKTOP_PET_IPC.read, 'turn-1');
  assert.deepEqual(calls.read, [MIXY]);
  app.webContents.emit(DESKTOP_PET_IPC.publish, { ...STATE, bubble: { kind: 'working' } });
  window.webContents.emit(DESKTOP_PET_IPC.read, 'turn-1');
  assert.deepEqual(calls.read, [MIXY], 'no longer shown');
});

test("Copy writes the shown reply's whole text (every page) to the clipboard; nothing for another key", async () => {
  const { window, app, calls } = await started();
  const text = `${'First page line.\n'.repeat(12)}Last page.`;
  app.webContents.emit(DESKTOP_PET_IPC.publish, { ...STATE, bubble: { kind: 'reply', key: 'long', text } });
  window.webContents.emit(DESKTOP_PET_IPC.copy, 'other');
  assert.deepEqual(calls.copy, []);
  window.webContents.emit(DESKTOP_PET_IPC.copy, 'long');
  assert.deepEqual(calls.copy, [text]);
});

test('auto-advance and auto-close: on by default, set from Settings, kept across a restart, drawn by the pet', async () => {
  const { pet, window, app, stored } = await started();
  assert.equal(pet.config().autoAdvance, true);
  assert.equal(pet.config().autoClose, true);
  assert.equal(window.webContents.lastView().autoAdvance, true);
  const off = await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'autoAdvance', false);
  assert.equal(off.autoAdvance, false);
  await app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'autoClose', false);
  assert.equal(window.webContents.lastView().autoAdvance, false);
  assert.equal(window.webContents.lastView().autoClose, false);
  assert.equal(lastConfig(app).autoClose, false, 'Settings hears it');
  assert.equal(stored().autoAdvance, false);
  pet.dispose();
  const again = await started({ prefs: stored() });
  assert.equal(again.pet.config().autoAdvance, false);
  assert.equal(again.pet.config().autoClose, false);
  await assert.rejects(async () => again.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'autoClose', 'no'));
  assert.equal(normalizeDesktopPetPrefs({ autoAdvance: 'no' }).autoAdvance, true, 'only an explicit off');
});

test('the app window closing detaches its channels; a new app window brings an owned pet back', async () => {
  const { pet, window, app } = await started({ prefs: FREE });
  app.events.emit('closed');
  assert.equal(app.webContents.handles(DESKTOP_PET_IPC.getConfig), false);
  assert.equal(app.events.listenerCount('move'), 0, 'its window listeners are gone');
  // Electron destroys an owned window with its owner (it goes here either way);
  // following no app window there is none until the next one comes.
  assert.equal(window.destroyed, true);
  assert.equal(pet.window(), null);
  const next = fakeApp();
  pet.attachAppWindow(next);
  await tick();
  assert.ok(pet.window(), 'recreated');
  assert.equal(pet.window().parent, next);
});

test('a closed app window whose webContents getter throws detaches without an uncaught error', async () => {
  const { app } = await started({ prefs: FREE });
  const contents = app.webContents;
  // Electron: a destroyed BrowserWindow throws on `webContents` during 'closed'.
  Object.defineProperty(app, 'webContents', {
    configurable: true,
    get() {
      throw new TypeError('Object has been destroyed');
    },
  });
  assert.doesNotThrow(() => app.events.emit('closed'));
  assert.equal(contents.handles(DESKTOP_PET_IPC.getConfig), false, 'its channels are released');
  assert.equal(app.events.listenerCount('move'), 0);
});

// ---- Validation --------------------------------------------------------------------------

test('pet IPC validation keeps only the narrow state and bounded inputs', () => {
  const state = requiredDesktopPetState({ ...STATE, extra: 'secret', face: { ...STATE.face, token: 'x' } });
  assert.deepEqual(state, STATE);
  assert.throws(() => requiredDesktopPetState({ ...STATE, sessionId: 'a/b' }), /session id/);
  assert.equal(requiredDesktopPetState({ ...STATE, quiet: 'yes' }).quiet, false, 'quiet only when exactly true');
  assert.equal(requiredDesktopPetState({ ...STATE, quiet: true }).quiet, true);
  assert.throws(() => requiredDesktopPetState({ ...STATE, bubble: { kind: 'reply', key: 'k', text: 'a\u0007' } }));
  assert.throws(() =>
    requiredDesktopPetState({ ...STATE, face: { room: true, members: Array(5).fill(STATE.face.members[0]) } })
  );
  assert.equal(requiredDesktopPetText(' hi '), 'hi');
  assert.throws(() => requiredDesktopPetText('x'.repeat(4001)));
  assert.deepEqual(requiredDesktopPetDrag({ phase: 'move', screenX: 1.6, screenY: 2 }), {
    phase: 'move',
    screenX: 2,
    screenY: 2,
  });
  assert.throws(() => requiredDesktopPetDrag({ phase: 'move', screenX: Number.NaN, screenY: 0 }));
  assert.deepEqual(requiredDesktopPetNudge(200, -3), { dx: 64, dy: -3 });
  assert.equal(requiredDesktopPetComposerRect(null), null);
  assert.deepEqual(requiredDesktopPetComposerRect({ x: 1.4, y: -2, width: 700.6, height: 90, extra: 1 }), {
    x: 1,
    y: -2,
    width: 701,
    height: 90,
  });
  assert.throws(() => requiredDesktopPetComposerRect({ x: 0, y: 0, width: -1, height: 1 }));
  assert.throws(() => requiredDesktopPetComposerRect({ x: 1e9, y: 0, width: 1, height: 1 }));
  const card = { x: 1, y: 600, width: 700, height: 90 };
  assert.equal(requiredDesktopPetComposer(null), null);
  assert.deepEqual(requiredDesktopPetComposer(card), { ...card, island: null }, 'no island reported');
  assert.deepEqual(requiredDesktopPetComposer({ ...card, island: 559.6 }), { ...card, island: 560 });
  assert.throws(() => requiredDesktopPetComposer({ ...card, island: 'top' }), /island/);
  assert.throws(() => requiredDesktopPetComposer({ ...card, island: 1e9 }), /island/);
  for (const scale of [50, 100, 150, 200]) assert.equal(requiredDesktopPetScale(scale), scale);
  for (const bad of [40, 210, 155, 99.5, '100', Number.NaN, null, undefined]) {
    assert.throws(() => requiredDesktopPetScale(bad), /scale/);
  }
  assert.deepEqual(
    requiredDesktopPetTheme({ scheme: 'dark', vars: { '--mx-text': ' #eee ', '--other': 'x', extra: 1 } }),
    { scheme: 'dark', vars: { '--mx-text': '#eee' } }
  );
  assert.throws(() => requiredDesktopPetTheme({ scheme: 'sepia', vars: {} }));
  assert.throws(() => requiredDesktopPetTheme({ scheme: 'dark', vars: { '--mx-text': 'red; x: y' } }));
  assert.equal(requiredDesktopPetCommand('keep-above'), 'keep-above');
  for (const command of ['settings', 'pin-here']) assert.equal(requiredDesktopPetCommand(command), command);
  assert.throws(() => requiredDesktopPetCommand('always-on-top'));
  assert.deepEqual(requiredDesktopPetOption('pinnedHere', true), { name: 'pinnedHere', value: true });
  assert.throws(() => requiredDesktopPetOption('enabled', true), /option/);
  assert.throws(() => requiredDesktopPetOption('pinnedHere', 'yes'), /boolean/);
});

test('stored prefs: malformed fields read as defaults', () => {
  assert.deepEqual(
    normalizeDesktopPetPrefs({
      enabled: 'yes',
      alwaysOnTop: true,
      keepAbove: 'yes',
      positions: { 1: { x: 'a' }, abc: { x: 1, y: 2 }, 7: { x: 1.4, y: 2 } },
    }),
    {
      enabled: true,
      keepAbove: false,
      collapsed: false,
      autoAdvance: true,
      autoClose: true,
      pinned: true,
      pinnedHere: false,
      onScreen: false,
      scale: 100,
      positions: { 7: { x: 1, y: 2 } },
      hereAnchor: null,
    }
  );
  assert.equal(normalizeDesktopPetPrefs({ pinned: false, pinnedHere: true }).pinnedHere, true);
  assert.equal(normalizeDesktopPetPrefs({ pinnedHere: true }).pinnedHere, false, 'never with the composer pin');
  assert.equal(normalizeDesktopPetPrefs({ pinned: false, pinnedHere: 'yes' }).pinnedHere, false);
  assert.equal(normalizeDesktopPetPrefs({ enabled: false }).enabled, false, 'explicit off kept');
  assert.equal(normalizeDesktopPetPrefs({ keepAbove: true }).keepAbove, true);
  for (const scale of [50, 150, 200]) assert.equal(normalizeDesktopPetPrefs({ scale }).scale, scale);
  for (const scale of [40, 210, 155, '150', null, Number.NaN]) {
    assert.equal(normalizeDesktopPetPrefs({ scale }).scale, 100, `stored ${String(scale)} reads as 100`);
  }
});

// ---- Size --------------------------------------------------------------------------

test('the bot scales 50–200%: only the sprite grows, the bubble, quick message and menu keep their room', () => {
  assert.deepEqual(desktopPetGeometry(100), {
    window: { width: 512, height: 336 },
    sprite: { left: 228, bottom: 8, size: 56 },
    coreWidth: 384,
  });
  assert.deepEqual(desktopPetGeometry(), desktopPetGeometry(100), '100% is today');
  assert.deepEqual(desktopPetGeometry(50).sprite, { left: 228, bottom: 8, size: 28 });
  assert.deepEqual(desktopPetGeometry(50).window, { width: 512, height: 336 }, 'smaller: the 100% window');
  assert.deepEqual(desktopPetGeometry(150).sprite.size, 84);
  assert.deepEqual(desktopPetGeometry(200).sprite, { left: 228, bottom: 8, size: 112 });
  assert.deepEqual(desktopPetGeometry(200).window, { width: 568, height: 336 });
  for (let scale = 50; scale <= 200; scale += 10) {
    const { window, sprite: box, coreWidth } = desktopPetGeometry(scale);
    assert.equal(box.size % 4, 0, `${scale}%: a whole number of quarter art pixels`);
    assert.ok(Math.abs(box.size - (56 * scale) / 100) <= 2, `${scale}%: about ${scale}% of 56px`);
    // The menu (200px at least, 8px from the box, 4px inside the window) fits on either side.
    assert.ok(window.width - (box.left + box.size) - 8 - 4 >= 200, `${scale}%: right menu room`);
    assert.ok(box.left - 8 - 4 >= 200, `${scale}%: left menu room`);
    // The 240px quick message centred under the box, inside what a pinned window keeps on screen.
    const centre = box.left + box.size / 2;
    assert.ok(centre - 120 >= 0 && centre + 120 <= coreWidth && coreWidth <= window.width, `${scale}%: quick message`);
    // As much room above the head for the bubble as at 100%.
    assert.ok(window.height - box.bottom - box.size >= 212 - 8 - 56, `${scale}%: bubble room`);
  }
});

test('the whole menu (nine items, the Size row, three dividers) fits in the window at every scale', () => {
  // 28px rows, 5px per divider, 6px inset and a hairline border each side (01-tokens.css, desktop-pet.css).
  assert.deepEqual([DESKTOP_PET_MENU.rows, DESKTOP_PET_MENU.dividers], [10, 3]);
  assert.ok(DESKTOP_PET_MENU.height >= 10 * 28 + 3 * 5 + 2 * 6 + 2, 'the room covers the drawn menu');
  for (const scale of [50, 100, 200]) {
    const { window, sprite: box } = desktopPetGeometry(scale);
    // The menu stands 4px above the window's bottom and stays 4px below its top.
    assert.ok(window.height - 4 - 4 >= DESKTOP_PET_MENU.height, `${scale}%: the menu fits (${window.height}px)`);
    assert.equal(box.bottom, 8, `${scale}%: the feet stay where main stands them`);
  }
});

test('Size is persisted, validated, and a new size replaces the window with one made for it', async () => {
  const { pet, app, windows, stored } = await started({ composer: COMPOSER });
  assert.deepEqual([windows[0].bounds.width, windows[0].bounds.height], [512, 336]);
  for (const bad of [45, 210, 105, '150', Number.NaN, null]) {
    await assert.rejects(async () => app.webContents.invoke(DESKTOP_PET_IPC.setScale, bad), /scale/);
  }
  assert.equal(windows.length, 1, 'a rejected size changes nothing');
  const config = await app.webContents.invoke(DESKTOP_PET_IPC.setScale, 200);
  assert.equal(config.scale, 200);
  assert.equal(stored().scale, 200, 'persisted');
  assert.equal(lastConfig(app).scale, 200, 'Settings hears it');
  await tick();
  assert.equal(windows[0].destroyed, true, 'the old window is not resized');
  const big = windows.at(-1);
  const shape = desktopPetGeometry(200);
  assert.deepEqual([big.bounds.width, big.bounds.height], [568, 336]);
  assert.equal(big.webContents.lastView().scale, 200, 'the overlay draws the sprite at the new size');
  assert.ok(Math.abs(sprite(big.bounds, shape).bottom - (APP_CONTENT.y + COMPOSER.y - NO_ISLAND_LINE)) <= 1);
  assert.deepEqual(
    big.shows.map(({ width, height }) => [width, height]),
    [[568, 336]],
    'shown once at its size'
  );
  await app.webContents.invoke(DESKTOP_PET_IPC.setScale, 200);
  assert.equal(windows.length, 2, 'the same size again: same window');
  pet.dispose();
  const restarted = await started({ prefs: stored(), composer: COMPOSER });
  assert.deepEqual([restarted.window.bounds.width, restarted.window.bounds.height], [568, 336], 'after restart');
  // Free: the feet stay where they stood.
  await restarted.app.webContents.invoke(DESKTOP_PET_IPC.setOption, 'pinned', false);
  const feet = sprite(restarted.window.bounds, shape);
  await restarted.app.webContents.invoke(DESKTOP_PET_IPC.setScale, 50);
  await tick();
  const small = restarted.windows.at(-1);
  assert.deepEqual([small.bounds.width, small.bounds.height], [512, 336]);
  const after = sprite(small.bounds, desktopPetGeometry(50));
  assert.deepEqual([after.left, after.bottom], [feet.left, feet.bottom]);
});
