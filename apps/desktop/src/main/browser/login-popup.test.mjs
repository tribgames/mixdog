import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The sign-in window without Electron: one shared log records every window,
// view and contents call in order, so the window's wiring is pinned as a whole.
const log = [];

class FakeContents extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.destroyed = false;
    this.sent = [];
    this.mainFrame = { name: `${name}-frame` };
    this.ipc = {
      handle: (channel, handler) => {
        log.push(`${name}.ipc.handle ${channel}`);
        this.handler = handler;
      },
    };
  }
  on(event, listener) {
    log.push(`${this.name}.on ${event}`);
    return super.on(event, listener);
  }
  setWindowOpenHandler(handler) {
    log.push(`${this.name}.setWindowOpenHandler`);
    this.openHandler = handler;
  }
  loadURL(url) {
    log.push(`${this.name}.loadURL ${url}`);
    return Promise.resolve();
  }
  send(channel, payload) {
    this.sent.push({ channel, payload: { ...payload } });
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    log.push(`${this.name}.close`);
    this.destroyed = true;
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    log.push('new BrowserWindow');
    this.options = options;
    this.destroyed = false;
    this.title = '';
    this.webContents = new FakeContents('shell');
    this.contentView = { addChildView: () => log.push('addChildView') };
    windows.push(this);
  }
  on(event, listener) {
    if (!this.registeringOnce) log.push(`window.on ${event}`);
    return super.on(event, listener);
  }
  once(event, listener) {
    log.push(`window.once ${event}`);
    this.registeringOnce = true;
    try {
      return super.once(event, listener);
    } finally {
      this.registeringOnce = false;
    }
  }
  getContentSize() {
    return [480, 720];
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    log.push('window.destroy');
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
  close() {
    log.push('window.close');
    this.destroy();
  }
  loadURL(url) {
    log.push(`window.loadURL ${url.slice(0, 'data:text/html;base64,'.length)}`);
    return Promise.resolve();
  }
  show() {
    log.push('window.show');
  }
  focus() {}
  setTitle(title) {
    this.title = title;
  }
}

class FakeView {
  constructor(options) {
    log.push('new WebContentsView');
    this.options = options;
    this.webContents = new FakeContents('site');
    views.push(this);
  }
  setBounds(bounds) {
    log.push(`setBounds ${bounds.width}x${bounds.height}`);
  }
}

const windows = [];
const views = [];
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
globalThis.__loginPopupElectron = {
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  screen: { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,const e=globalThis.__loginPopupElectron;' +
            'export const app={getLocale:()=>"en",getPath:()=>"",getAppPath:()=>"",isPackaged:false};' +
            'export const BrowserWindow=e.BrowserWindow;export const WebContentsView=e.WebContentsView;' +
            'export const screen=e.screen;export const nativeTheme={shouldUseDarkColors:false};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { createBrowserLoginPopup } = await import('./login-popup.ts');

const PAGE_URL = 'https://shop.example/login';
const parentWindow = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }) };

/** A login takeover of `s1` opened; `ready()` answers its window, site and shell. */
function fixture(options = {}) {
  log.length = 0;
  windows.length = 0;
  views.length = 0;
  const popup = createBrowserLoginPopup({
    parent: () => {
      log.push('parent()');
      return parentWindow;
    },
    session: () => {
      log.push('session()');
      return 'partition';
    },
    urlPolicy: {},
    ready: async () => true,
    settle: async (sessionId, id) => {
      log.push(`settle ${sessionId} ${id}`);
      return true;
    },
    afterSignIn: (sessionId, id) => {
      log.push(`afterSignIn ${sessionId} ${id}`);
    },
    preloadPath: 'preload.js',
    ...options,
  });
  popup.sync('s1', { id: 't1', url: PAGE_URL, tab: '' });
  const opened = popup.open('s1', 't1');
  return {
    popup,
    opened,
    async ready() {
      await new Promise((resolve) => setImmediate(resolve));
      return { window: windows[0], view: views[0], site: views[0].webContents, shell: windows[0].webContents };
    },
  };
}

const event = () => {
  const value = { prevented: false, preventDefault: () => (value.prevented = true) };
  return value;
};

test('the sign-in window is built and wired in one fixed order once human control is ready', async () => {
  const f = fixture();
  const { window, view, site, shell } = await f.ready();
  assert.deepEqual(log, [
    'parent()',
    'new BrowserWindow',
    'session()',
    'new WebContentsView',
    'addChildView',
    'setBounds 480x664',
    'window.on resize',
    'site.on will-navigate',
    'site.on will-redirect',
    'site.setWindowOpenHandler',
    'site.on did-create-window',
    'site.on did-navigate',
    'site.on page-title-updated',
    'site.on did-navigate-in-page',
    'site.on render-process-gone',
    'shell.on render-process-gone',
    'shell.on will-navigate',
    'shell.setWindowOpenHandler',
    'shell.on did-finish-load',
    'shell.ipc.handle browser-login-control',
    'window.on closed',
    'window.once ready-to-show',
    'window.loadURL data:text/html;base64,',
    `site.loadURL ${PAGE_URL}`,
  ]);
  assert.deepEqual(window.options, {
    x: 360,
    y: 40,
    width: 480,
    height: 720,
    minWidth: 360,
    minHeight: 420,
    parent: parentWindow,
    modal: false,
    show: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Sign in',
    backgroundColor: '#f7f7f7',
    webPreferences: {
      preload: 'preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  assert.deepEqual(view.options, {
    webPreferences: {
      session: 'partition',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  assert.deepEqual(f.popup.status('s1', 't1'), { state: 'open' });
  // The shell gets its state only once it has loaded; the site's title names the window.
  site.emit('did-navigate', {}, 'https://shop.example/next');
  assert.deepEqual(shell.sent, []);
  shell.emit('did-finish-load');
  assert.equal(shell.sent.length, 1);
  assert.equal(shell.sent[0].channel, 'browser-login-state');
  assert.equal(shell.sent[0].payload.tone, '');
  assert.match(shell.sent[0].payload.status, /paused/);
  site.emit('page-title-updated', {}, '  Shop  ');
  assert.equal(window.title, 'Shop');
  site.emit('page-title-updated', {}, ' ');
  assert.equal(window.title, 'Sign in');
  window.emit('ready-to-show');
  assert.equal(log.at(-1), 'window.show');
  // The shell itself never navigates or opens windows.
  const shellNavigation = event();
  shell.emit('will-navigate', shellNavigation);
  assert.equal(shellNavigation.prevented, true);
  assert.deepEqual(shell.openHandler(), { action: 'deny' });
});

test('a refused or non-HTTPS navigation is blocked and said; a provider refusal ends the window as refused', async () => {
  const f = fixture();
  const { window, site, shell } = await f.ready();
  shell.emit('did-finish-load');
  const blocked = event();
  site.emit('will-navigate', blocked, 'http://example.com/');
  assert.equal(blocked.prevented, true);
  assert.equal(shell.sent.at(-1).payload.tone, 'blocked');
  assert.match(shell.sent.at(-1).payload.status, /HTTPS/);
  const redirect = event();
  site.emit('will-redirect', redirect, 'https://shop.example/ok');
  assert.equal(redirect.prevented, false);
  // A later navigation clears the notice; a subframe one changes nothing.
  site.emit('did-navigate-in-page', {}, 'https://shop.example/frame', false);
  assert.equal(shell.sent.at(-1).payload.tone, 'blocked');
  site.emit('did-navigate-in-page', {}, 'https://shop.example/#a', true);
  assert.equal(shell.sent.at(-1).payload.tone, '');
  // The site's own windows: about:blank and HTTPS keep their opener, plain HTTP is denied and said.
  const allowed = site.openHandler({ url: 'about:blank' });
  assert.deepEqual(allowed, {
    action: 'allow',
    overrideBrowserWindowOptions: {
      parent: window,
      width: 480,
      height: 640,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    },
  });
  const sentBefore = shell.sent.length;
  assert.deepEqual(site.openHandler({ url: 'http://example.com/' }), { action: 'deny' });
  assert.equal(shell.sent.length, sentBefore + 1);
  assert.equal(shell.sent.at(-1).payload.tone, 'blocked');
  // A window the site opened is guarded the same way.
  const child = new FakeContents('child');
  log.length = 0;
  site.emit('did-create-window', { webContents: child });
  assert.deepEqual(log, [
    'child.on will-navigate',
    'child.on will-redirect',
    'child.setWindowOpenHandler',
    'child.on did-create-window',
  ]);
  const childBlocked = event();
  child.emit('will-navigate', childBlocked, 'http://example.com/');
  assert.equal(childBlocked.prevented, true);
  // Google's "browser may not be secure" page: refused.
  site.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/rejected');
  assert.deepEqual(await f.opened, { state: 'refused', provider: 'Google' });
  assert.equal(window.isDestroyed(), true);
});

test('a trusted auto-close rule shows signed-in and completes once by itself', async () => {
  const f = fixture({
    autoCloseRules: [{ host: 'shop.example', signedIn: (url) => url.pathname === '/home' }],
    autoCloseDelayMs: 0,
  });
  const { site, shell } = await f.ready();
  shell.emit('did-finish-load');
  site.emit('did-navigate', {}, 'https://shop.example/home');
  assert.equal(shell.sent.at(-1).payload.tone, 'ok');
  // Already ok: a second matching navigation schedules nothing more.
  site.emit('did-navigate', {}, 'https://shop.example/home');
  assert.deepEqual(await f.opened, { state: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    log.filter((line) => line.startsWith('afterSignIn') || line.startsWith('settle')),
    ['afterSignIn s1 t1', 'settle s1 t1']
  );
});

test("the shell's control channel answers only its own frame: close stays pending, complete settles", async () => {
  const f = fixture();
  const { window, shell } = await f.ready();
  const own = { sender: shell, senderFrame: shell.mainFrame };
  await assert.rejects(shell.handler({ sender: {}, senderFrame: shell.mainFrame }, { action: 'close' }), {
    message: 'Invalid sign-in window sender',
  });
  await assert.rejects(shell.handler({ sender: shell, senderFrame: {} }, { action: 'close' }), {
    message: 'Invalid sign-in window sender',
  });
  await assert.rejects(shell.handler(own, { action: 'other' }), { message: 'Invalid sign-in window request' });
  await assert.rejects(shell.handler(own, null), { message: 'Invalid sign-in window request' });
  assert.equal(await shell.handler(own, { action: 'complete' }), true);
  assert.deepEqual(await f.opened, { state: 'done' });
  assert.equal(window.isDestroyed(), true);

  const g = fixture();
  const second = await g.ready();
  const ownSecond = { sender: second.shell, senderFrame: second.shell.mainFrame };
  assert.equal(await second.shell.handler(ownSecond, { action: 'close' }), true);
  assert.deepEqual(await g.opened, { state: 'closed' });
  assert.ok(log.includes('site.close'), "the site's page closes with its window");
  assert.deepEqual(g.popup.status('s1', 't1'), { state: 'closed' });
});

test('a crash of the site or of the shell ends the window as closed, never done', async () => {
  for (const side of ['site', 'shell']) {
    const f = fixture();
    const parts = await f.ready();
    parts[side].emit('render-process-gone');
    assert.deepEqual(await f.opened, { state: 'closed' });
    assert.equal(parts.window.isDestroyed(), true);
    assert.equal(log.includes('settle s1 t1'), false);
  }
});
