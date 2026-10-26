import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Page windows without Electron: each window owns one page, records which
// listeners the lifecycle registers (in order), and tears down like Electron
// (destroying a window destroys its page, then reports `closed`).
const log = [];
let nextId = 1;

class FakeGuest extends EventEmitter {
  constructor() {
    super();
    this.id = nextId++;
    this.url = '';
    this.loads = [];
    this.zoom = 1;
    this.reloads = 0;
    this.destroyed = false;
    this.listenerOrder = [];
    this.navigationHistory = { length: () => 1 };
  }
  on(event, listener) {
    if (!this.registeringOnce) this.listenerOrder.push(event);
    return super.on(event, listener);
  }
  once(event, listener) {
    this.listenerOrder.push(`once:${event}`);
    this.registeringOnce = true;
    try {
      return super.once(event, listener);
    } finally {
      this.registeringOnce = false;
    }
  }
  getURL() {
    return this.url;
  }
  loadURL(url) {
    this.url = url;
    this.loads.push(url);
    return Promise.resolve();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isLoadingMainFrame() {
    return false;
  }
  insertCSS() {
    return Promise.resolve('');
  }
  executeJavaScript() {
    return Promise.resolve();
  }
  setWindowOpenHandler(handler) {
    this.openHandler = handler;
  }
  getZoomFactor() {
    return this.zoom;
  }
  setZoomFactor(factor) {
    this.zoom = factor;
  }
  getTitle() {
    return `title ${this.id}`;
  }
  reload() {
    this.reloads += 1;
  }
  send(channel, payload) {
    log.push(['send', channel, payload]);
  }
  close() {
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeGuest();
    this.destroyed = false;
    this.size = [options?.width ?? 0, options?.height ?? 0];
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    log.push(['destroy', this.webContents.id]);
    this.webContents.destroy();
    this.emit('closed');
  }
  getContentSize() {
    return this.size;
  }
  setContentSize(width, height) {
    this.size = [width, height];
  }
}

globalThis.__guestLifecycleElectron = { FakeWindow };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,const e=globalThis.__guestLifecycleElectron;' +
            'export const app={getPath:()=>"",getAppPath:()=>"",isPackaged:false,isHardwareAccelerationEnabled:()=>false};' +
            'export const BrowserWindow=e.FakeWindow;export const BaseWindow=e.FakeWindow;export class WebContentsView{};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { createBrowserGuestLifecycle } = await import('./guest-lifecycle.ts');
const { BrowserGuestStateStore } = await import('./guest-state.ts');
const { BrowserSessionRegistry } = await import('./session-registry.ts');
const { DESKTOP_IPC } = await import('../../shared/contract.ts');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  log.length = 0;
  const shell = new FakeWindow();
  const shellAttachEvents = shell.webContents.listenerOrder;
  const state = new BrowserGuestStateStore();
  const sessions = new BrowserSessionRegistry();
  const cdpCalls = [];
  const cdp = {
    guestDebugger: (guest) => {
      cdpCalls.push(['guestDebugger', guest.id]);
      return overrides.cdpFailure ? Promise.reject(new Error(overrides.cdpFailure)) : Promise.resolve();
    },
    attachOpenedPage: (guest) => {
      cdpCalls.push(['attachOpenedPage', guest.id]);
      return Promise.resolve();
    },
  };
  const guests = [];
  const popups = [];
  const surfaceRequests = [];
  const settles = [];
  const lifecycle = createBrowserGuestLifecycle({
    window: shell,
    partitionSession: {},
    state,
    sessions,
    cdp,
    urlPolicy: {},
    isBackgroundBusy: () => false,
    onGuest: (guest) => guests.push(guest),
    onPopup: (opener, popup, selected) => popups.push([opener.id, popup.id, selected]),
    onSurfaceRequest: (request) => surfaceRequests.push(request),
    waitForLoadSettle: (guest, timeoutMs) => {
      settles.push([guest.id, timeoutMs]);
      return overrides.settleFailure ? Promise.reject(new Error(overrides.settleFailure)) : Promise.resolve();
    },
    waitUntilShown: overrides.waitUntilShown,
  });
  return { shell, shellAttachEvents, state, sessions, cdpCalls, guests, popups, surfaceRequests, settles, lifecycle };
}

/** A popup the page `opener` opens, as Electron reports it (did-create-window). */
function openPopup(opener, url) {
  const child = new FakeWindow();
  opener.emit('did-create-window', child, { url });
  return child;
}

test('a primary page is wired, in order, before its debugger comes up', async () => {
  const h = harness();
  // A webview attach is refused on the shell itself.
  assert.deepEqual(h.shellAttachEvents, ['will-attach-webview']);
  let prevented = false;
  h.shell.webContents.emit('will-attach-webview', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);

  const guest = await h.lifecycle.ensureGuest('s1');
  assert.deepEqual(guest.loads, ['about:blank']);
  assert.deepEqual(h.guests, [guest]);
  assert.deepEqual(guest.listenerOrder, [
    'did-navigate',
    'once:destroyed',
    'dom-ready',
    'dom-ready',
    'will-navigate',
    'will-redirect',
    'did-start-navigation',
    'did-navigate',
    'did-create-window',
    'render-process-gone',
    'unresponsive',
    'responsive',
    'did-finish-load',
    'did-fail-load',
    'did-start-navigation',
  ]);
  assert.equal(typeof guest.openHandler, 'function');
  assert.deepEqual(h.cdpCalls, [['guestDebugger', guest.id]]);
  // Revealing is the default: the shell and paired clients both hear it.
  assert.deepEqual(log, [['send', DESKTOP_IPC.browserOpenRequested, { sessionId: 's1', reveal: true }]]);
  assert.deepEqual(h.surfaceRequests, [{ sessionId: 's1', reveal: true }]);
  assert.equal(await h.lifecycle.ensureGuest('s1', { reveal: false }), guest);
  assert.equal(h.surfaceRequests.length, 1);
});

test('navigation the URL policy refuses is prevented and reported on the page', async () => {
  const h = harness();
  const guest = await h.lifecycle.ensureGuest('s1', { reveal: false });
  const navigate = (event, url) => {
    let prevented = false;
    guest.emit(event, { preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  assert.equal(navigate('will-navigate', 'about:blank'), false);
  assert.equal(navigate('will-navigate', 'https://example.com/'), false);
  assert.equal(navigate('will-redirect', 'file:///etc/passwd'), true);
  assert.equal(h.state.for(guest).networkFailures.length, 1);
  assert.match(h.state.for(guest).networkFailures[0], /^Blocked page navigation: /);
});

test('a failed debugger start is a page diagnostic, never a host error', async () => {
  const h = harness({ cdpFailure: 'no target' });
  const guest = await h.lifecycle.ensureGuest('s1', { reveal: false });
  await flush();
  assert.match(h.state.for(guest).console.format('all', '', 10), /CDP initialization failed: no target/);
});

test('popups become numbered background pages of the opener session', async () => {
  const h = harness();
  const opener = await h.lifecycle.ensureGuest('s1', { reveal: false });
  const first = openPopup(opener, 'https://example.com/a');
  const entry = h.sessions.backgroundPages('s1').get('popup-1');
  assert.equal(entry.guest, first.webContents);
  assert.equal(entry.kind, 'popup');
  assert.equal(entry.opener, opener);
  assert.equal(entry.openerPageId, h.state.pageId(opener));
  assert.deepEqual(h.state.for(opener).openedPopups, ['popup-1']);
  assert.deepEqual(h.popups, [[opener.id, first.webContents.id, false]]);
  // A page window.open navigates gets its debugger without a blank first load.
  assert.deepEqual(h.cdpCalls.at(-1), ['attachOpenedPage', first.webContents.id]);
  assert.equal(h.sessions.currentGuest('s1'), opener);

  // A person's own gesture brings the popup forward as their selected tab.
  h.state.for(opener).actor = 'person';
  h.state.for(opener).personDialogAnswerAt = Date.now();
  const decision = opener.openHandler({ url: 'https://example.com/b', disposition: 'foreground-tab' });
  assert.equal(decision.action, 'allow');
  const second = openPopup(opener, 'https://example.com/b');
  assert.ok(h.sessions.backgroundPages('s1').has('popup-2'));
  assert.deepEqual(h.popups.at(-1), [opener.id, second.webContents.id, true]);
  assert.equal(h.sessions.currentGuest('s1'), second.webContents);

  // A closed popup leaves the registry with its window.
  first.destroy();
  assert.equal(h.sessions.backgroundPages('s1').has('popup-1'), false);
  assert.equal(
    h.lifecycle.backgroundEntryByPageId('s1', h.state.pageId(second.webContents).toUpperCase())[0],
    'popup-2'
  );
  assert.equal(h.lifecycle.backgroundEntryByPageId('s1', 'p999'), null);

  // Released sessions start their popup names over.
  h.lifecycle.releaseSession('s1');
  const again = await h.lifecycle.ensureGuest('s1', { reveal: false });
  openPopup(again, 'https://example.com/c');
  assert.deepEqual([...h.sessions.backgroundPages('s1').keys()], ['popup-1']);
});

test('a popup past the session capacity is destroyed and reported on its opener', async () => {
  const h = harness();
  for (let index = 0; index < 6; index += 1) h.lifecycle.ensureOffscreen('s1', `agent-${index}`);
  const opener = h.sessions.backgroundPages('s1').get('agent-0').guest;
  const popup = openPopup(opener, 'https://example.com/a');
  assert.equal(popup.isDestroyed(), true);
  assert.equal(h.sessions.backgroundPages('s1').size, 6);
  assert.equal(h.popups.length, 0);
  assert.equal(h.state.for(opener).networkFailures.length, 1);
  assert.match(h.state.for(opener).networkFailures[0], /^Blocked popup creation: /);
  assert.throws(() => h.lifecycle.ensureOffscreen('s1', 'one-more'));
});

test('ensureOffscreen reuses a live named page and replaces a closed one', () => {
  const h = harness();
  const page = h.lifecycle.ensureOffscreen('s1', 'research');
  assert.equal(page.kind, 'agent');
  assert.equal(h.sessions.backgroundPages('s1').get('research'), page);
  assert.deepEqual(h.cdpCalls, [['guestDebugger', page.guest.id]]);
  page.lastUsedAt = 0;
  assert.equal(h.lifecycle.ensureOffscreen('s1', 'research'), page);
  assert.ok(page.lastUsedAt > 0);
  page.window.destroy();
  const replaced = h.lifecycle.ensureOffscreen('s1', 'research');
  assert.notEqual(replaced, page);
  assert.equal(h.sessions.backgroundPages('s1').get('research'), replaced);
});

test('an unloaded session restores its pages: address, zoom, size, and selection', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  primary.url = 'https://example.com/primary';
  primary.zoom = 1.5;
  h.lifecycle.ensureOffscreen('s1', 'research');
  const research = h.sessions.backgroundPages('s1').get('research');
  research.guest.url = 'https://example.com/research';
  research.window.setContentSize(800, 600);
  research.keepAlive = true;
  h.lifecycle.ensureOffscreen('s1', 'blank');
  h.sessions.selectGuest('s1', research.guest);
  openPopup(primary, 'https://example.com/popup');
  h.sessions.backgroundPages('s1').get('popup-1').guest.url = 'https://example.com/popup';

  log.length = 0;
  h.lifecycle.releaseSession('s1', true);
  // Primary first, then the background pages in their registry order.
  assert.deepEqual(
    log.map(([kind, id]) => [kind, id]),
    [
      ['destroy', primary.id],
      ['destroy', research.guest.id],
      ['destroy', research.guest.id + 1],
      ['destroy', research.guest.id + 2],
    ]
  );
  assert.equal(h.sessions.liveGuest('s1'), null);
  assert.equal(h.sessions.backgroundPages('s1').size, 0);

  const before = h.cdpCalls.length;
  const restoring = h.lifecycle.restoreSession('s1');
  assert.equal(h.lifecycle.restoreSession('s1'), restoring);
  await restoring;
  const restoredPrimary = h.sessions.visibleGuests('s1')[0];
  assert.deepEqual(restoredPrimary.loads, ['about:blank', 'https://example.com/primary']);
  assert.equal(restoredPrimary.zoom, 1.5);
  // The blank page had nothing to come back to.
  assert.deepEqual([...h.sessions.backgroundPages('s1').keys()], ['research', 'popup-1']);
  const restoredResearch = h.sessions.backgroundPages('s1').get('research');
  assert.deepEqual(restoredResearch.guest.loads, ['about:blank', 'https://example.com/research']);
  assert.deepEqual(restoredResearch.window.getContentSize(), [800, 600]);
  assert.equal(restoredResearch.kind, 'agent');
  assert.equal(restoredResearch.keepAlive, true);
  const restoredPopup = h.sessions.backgroundPages('s1').get('popup-1');
  // A restored popup comes back as the person's own page, kept alive.
  assert.equal(restoredPopup.kind, 'user');
  assert.equal(restoredPopup.keepAlive, true);
  assert.equal(h.sessions.currentGuest('s1'), restoredResearch.guest);
  // Restored background pages attach only after their first document.
  assert.deepEqual(h.cdpCalls.slice(before), [['guestDebugger', restoredPrimary.id]]);
  restoredResearch.guest.emit('dom-ready');
  assert.deepEqual(h.cdpCalls.at(-1), ['guestDebugger', restoredResearch.guest.id]);
  // Nothing is left to restore.
  await h.lifecycle.restoreSession('s1');
  assert.equal(h.sessions.backgroundPages('s1').size, 2);
});

test('deleting a session forgets what it would restore', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  primary.url = 'https://example.com/primary';
  h.lifecycle.releaseSession('s1', true);
  h.lifecycle.releaseSession('s1');
  await h.lifecycle.restoreSession('s1');
  assert.equal(h.sessions.liveGuest('s1'), null);
});

test('a restore overtaken by a release fails without tearing anything else down', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  primary.url = 'https://example.com/primary';
  h.lifecycle.releaseSession('s1', true);
  const restoring = h.lifecycle.restoreSession('s1');
  h.lifecycle.releaseSession('s1');
  await assert.rejects(restoring, { message: 'Browser page changed during restore.' });
});

test('a restore whose page creation fails releases the partial set and keeps descriptors', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  primary.url = 'https://example.com/primary';
  h.lifecycle.ensureOffscreen('s1', 'research').guest.url = 'https://example.com/research';
  h.lifecycle.releaseSession('s1', true);
  const originalLoad = FakeGuest.prototype.loadURL;
  let failed = false;
  FakeGuest.prototype.loadURL = function (url) {
    // The first background page's blank commit fails once.
    if (!failed && url === 'about:blank' && h.sessions.backgroundPageForGuest('s1', this)) {
      failed = true;
      return Promise.reject(new Error('load aborted'));
    }
    return originalLoad.call(this, url);
  };
  try {
    await assert.rejects(h.lifecycle.restoreSession('s1'), { message: 'load aborted' });
  } finally {
    FakeGuest.prototype.loadURL = originalLoad;
  }
  assert.equal(h.sessions.liveGuest('s1'), null);
  assert.equal(h.sessions.backgroundPages('s1').size, 0);
  await h.lifecycle.restoreSession('s1');
  assert.equal(h.sessions.backgroundPages('s1').get('research').guest.url, 'https://example.com/research');
});

test('surface requests need a live shell window; a failed open is reported quietly', async () => {
  const h = harness();
  h.lifecycle.requestBrowserSurface('s1', 'hide');
  h.lifecycle.requestBrowserSurface('s1', 'handoff');
  assert.deepEqual(h.surfaceRequests, [
    { sessionId: 's1', hide: true },
    { sessionId: 's1', reveal: true, handoff: true },
  ]);
  h.lifecycle.reportOpenFailure('s1', 'refused', 'p9');
  assert.deepEqual(h.surfaceRequests.at(-1), { sessionId: 's1', reveal: true, tabId: 'p9', error: 'refused' });
  h.shell.destroy();
  assert.throws(() => h.lifecycle.requestBrowserSurface('s1', true), { message: 'desktop window is unavailable' });
  h.lifecycle.reportOpenFailure('s1', 'refused');
  assert.equal(h.surfaceRequests.length, 3);
});

test('revealPage selects the page and reports whether a panel showed it', async () => {
  const shown = [];
  const h = harness({
    waitUntilShown: (guest, timeoutMs) => {
      shown.push([guest.id, timeoutMs]);
      return Promise.resolve(true);
    },
  });
  await h.lifecycle.ensureGuest('s1', { reveal: false });
  const page = h.lifecycle.ensureOffscreen('s1', 'research');
  assert.equal(await h.lifecycle.revealPage('s1', page.guest), 'shown');
  assert.deepEqual(shown, [[page.guest.id, 3_000]]);
  assert.equal(h.sessions.currentGuest('s1'), page.guest);
  assert.deepEqual(h.surfaceRequests.at(-1), {
    sessionId: 's1',
    reveal: true,
    tabId: h.state.pageId(page.guest),
    title: page.guest.getTitle(),
  });
  const plain = harness();
  const guest = await plain.lifecycle.ensureGuest('s1', { reveal: false });
  assert.equal(await plain.lifecycle.revealPage('s1', guest), 'pending');
});

test('discardCreatedPage closes only pages that never held a document', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  const page = h.lifecycle.ensureOffscreen('s1', 'research');
  page.guest.url = 'https://example.com/';
  assert.equal(h.lifecycle.discardCreatedPage('s1', page.guest), false);
  page.guest.url = '';
  assert.equal(h.lifecycle.discardCreatedPage('s1', page.guest), true);
  assert.equal(page.window.isDestroyed(), true);
  assert.equal(h.sessions.backgroundPages('s1').size, 0);
  assert.equal(h.lifecycle.discardCreatedPage('s1', page.guest), false);
  assert.equal(h.lifecycle.discardCreatedPage('s2', primary), false);
  assert.equal(h.lifecycle.discardCreatedPage('s1', primary), true);
  assert.equal(primary.isDestroyed(), true);
  assert.deepEqual(h.sessions.visibleGuests('s1'), []);
});

test('recoverCrashedGuest reloads a crashed page once and records a failed recovery', async () => {
  const h = harness();
  const guest = await h.lifecycle.ensureGuest('s1', { reveal: false });
  await h.lifecycle.recoverCrashedGuest(guest);
  assert.equal(guest.reloads, 0);
  h.state.markCrashed(guest, 'renderer crashed');
  await h.lifecycle.recoverCrashedGuest(guest);
  assert.equal(guest.reloads, 1);
  assert.equal(h.state.for(guest).fault, '');
  assert.equal(h.settles.length, 1);

  const failing = harness({ settleFailure: 'timed out' });
  const other = await failing.lifecycle.ensureGuest('s1', { reveal: false });
  failing.state.markCrashed(other, 'renderer crashed');
  await failing.lifecycle.recoverCrashedGuest(other);
  assert.equal(failing.state.for(other).fault, 'page recovery failed: timed out');

  const gone = harness();
  const dead = await gone.lifecycle.ensureGuest('s1', { reveal: false });
  gone.state.markCrashed(dead, 'renderer crashed');
  dead.destroy();
  await assert.rejects(gone.lifecycle.recoverCrashedGuest(dead), { message: 'browser page is unavailable' });
});

test('teardown destroys every page without folding a panel', async () => {
  const h = harness();
  const primary = await h.lifecycle.ensureGuest('s1', { reveal: false });
  primary.url = 'https://example.com/';
  const page = h.lifecycle.ensureOffscreen('s2', 'research');
  h.lifecycle.releaseSession('s1', true);
  const kept = await h.lifecycle.ensureGuest('s3', { reveal: false });
  log.length = 0;
  h.surfaceRequests.length = 0;
  h.lifecycle.destroyAllBackgroundPages();
  h.lifecycle.destroyAllPrimaryPages();
  assert.deepEqual(log, [
    ['destroy', page.guest.id],
    ['destroy', kept.id],
  ]);
  assert.deepEqual(h.surfaceRequests, []);
  assert.equal(h.sessions.allBackgroundEntries().length, 0);
  // Suspended sessions are forgotten with the pages.
  await h.lifecycle.restoreSession('s1');
  assert.equal(h.sessions.liveGuest('s1'), null);
});

test('losing the last page folds its panel', async () => {
  const h = harness();
  const page = h.lifecycle.ensureOffscreen('s1', 'research');
  page.window.destroy();
  assert.deepEqual(h.surfaceRequests, [{ sessionId: 's1', hide: true }]);
  h.lifecycle.destroyBackgroundPage('s1', 'research', page);
});
