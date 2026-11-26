import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const userData = mkdtempSync(join(tmpdir(), 'mixdog-lazy-partition-'));
const fromPartitionCalls = [];
let cookieSetGate = null;
let cookieSetCalls = 0;
let onCookieSetStarted = null;

function fakePartitionSession() {
  return {
    cookies: {
      get: async () => [],
      set: async () => {
        cookieSetCalls += 1;
        onCookieSetStarted?.();
        if (cookieSetGate) await cookieSetGate;
      },
      remove: async () => {},
      on() {},
      removeListener() {},
    },
    webRequest: {
      onBeforeRequest() {},
    },
    on() {},
    removeListener() {},
    setUserAgent() {},
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    clearStorageData: async () => {},
    clearCache: async () => {},
    clearAuthCache: async () => {},
  };
}

globalThis.__lazyPartitionElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : tmpdir()),
    userAgentFallback: 'Mixdog/1.0 Chrome/130.0.0.0 Electron/43.0.0',
    on() {},
    getSystemLocale: () => 'en-US',
    getPreferredSystemLanguages: () => ['en-US'],
  },
  ipcMain: {
    handle() {},
    removeHandler() {},
    on() {},
    removeListener() {},
  },
  session: {
    defaultSession: { setUserAgent() {} },
    fromPartition(name) {
      fromPartitionCalls.push(name);
      return fakePartitionSession();
    },
  },
  sharedTexture: {
    importSharedTexture() {},
    sendSharedTexture() {},
  },
  webContents: {
    getAllWebContents: () => [],
    fromFrame: () => null,
    fromId: () => null,
  },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true, toDataURL: () => '' }),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString('utf8'),
  },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    on() {},
    removeListener() {},
  },
  net: {
    fetch: async () => new Response(''),
  },
  shell: {
    openExternal: async () => {},
  },
  BrowserWindow: class {},
  BaseWindow: class {},
  WebContentsView: class {},
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'electron') return next(specifier, context);
    return {
      url:
        'data:text/javascript,' +
        'export const app=globalThis.__lazyPartitionElectron.app;' +
        'export const ipcMain=globalThis.__lazyPartitionElectron.ipcMain;' +
        'export const session=globalThis.__lazyPartitionElectron.session;' +
        'export const sharedTexture=globalThis.__lazyPartitionElectron.sharedTexture;' +
        'export const webContents=globalThis.__lazyPartitionElectron.webContents;' +
        'export const nativeImage=globalThis.__lazyPartitionElectron.nativeImage;' +
        'export const safeStorage=globalThis.__lazyPartitionElectron.safeStorage;' +
        'export const screen=globalThis.__lazyPartitionElectron.screen;' +
        'export const net=globalThis.__lazyPartitionElectron.net;' +
        'export const shell=globalThis.__lazyPartitionElectron.shell;' +
        'export const BrowserWindow=globalThis.__lazyPartitionElectron.BrowserWindow;' +
        'export const BaseWindow=globalThis.__lazyPartitionElectron.BaseWindow;' +
        'export const WebContentsView=globalThis.__lazyPartitionElectron.WebContentsView;',
      shortCircuit: true,
    };
  },
});

const { createBrowserHostFoundation } = await import('./host-foundation.ts');
const { createBrowserPageOwner } = await import('./page-owner.ts');
const { BROWSER_PARTITION } = await import('./host-types.ts');

test('createBrowserHostFoundation defers persist:mixdog-browser partition until first browser use', async () => {
  const windowSession = { setUserAgent() {} };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      session: windowSession,
      send() {},
      mainFrame: {},
    },
  };
  let readyCount = 0;
  const foundation = createBrowserHostFoundation(fakeWindow, {
    remoteSession: false,
    onPartitionReady: () => {
      readyCount += 1;
    },
  });

  try {
    // Startup construction, idle queries and profileImporter status reads must not create persist:mixdog-browser.
    assert.deepEqual(fromPartitionCalls, []);
    assert.equal(readyCount, 0);
    assert.equal(foundation.partition.permissions.refused('https://example.test', 'geolocation'), false);
    assert.equal(foundation.partition.downloadLedger.hasActiveDownload('s1'), false);
    assert.deepEqual(foundation.partition.downloadLedger.downloadsForSession('s1'), []);
    foundation.partition.downloadLedger.release('s1');
    await foundation.profileImporter.savedKeyStatus();
    await foundation.profileImporter.cookieAutoImportState.read();
    assert.deepEqual(fromPartitionCalls, []);

    // First actual browser use creates persist:mixdog-browser once.
    const first = foundation.partition.session;
    const second = foundation.partition.session;
    assert.equal(first, second);
    assert.deepEqual(fromPartitionCalls, [BROWSER_PARTITION]);
    assert.equal(readyCount, 1);
  } finally {
    foundation.stopSessionAutosave();
    await foundation.cookieJar.dispose();
    foundation.partition.dispose();
  }
});

test('first browser page awaits sessionStore.restore() before creating a window', async (t) => {
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  fromPartitionCalls.length = 0;
  cookieSetCalls = 0;
  const browserStateDir = join(userData, 'browser-state');
  mkdirSync(browserStateDir, { recursive: true });
  writeFileSync(
    join(browserStateDir, 'session-cookies.bin'),
    JSON.stringify({
      savedAt: Date.now(),
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.test', path: '/', secure: true, hostOnly: true }],
    })
  );

  let releaseCookies;
  cookieSetGate = new Promise((resolve) => (releaseCookies = resolve));
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      session: { setUserAgent() {} },
      send() {},
      mainFrame: {},
    },
  };
  const foundation = createBrowserHostFoundation(fakeWindow, { remoteSession: false });
  let windowsCreated = 0;
  const owner = createBrowserPageOwner({
    sessions: foundation.sessions,
    beforeCreate: foundation.ensurePartitionReady,
    create() {
      windowsCreated += 1;
      const guest = {
        id: windowsCreated,
        isDestroyed: () => false,
        loadURL: async () => {},
        on() {},
        once() {},
        getURL: () => 'about:blank',
      };
      return { window: { isDestroyed: () => false, destroy() {} }, guest };
    },
    initialize() {},
    adoptPage() {},
  });

  try {
    const cookieSetStarted = new Promise((resolve) => {
      onCookieSetStarted = resolve;
    });
    const ensurePromise = owner.ensure('s1');
    await cookieSetStarted;
    assert.equal(cookieSetCalls, 1, 'session cookie restore has started');
    assert.equal(windowsCreated, 0, 'no BrowserWindow created while cookie restore is still pending');

    releaseCookies();
    await ensurePromise;
    assert.equal(windowsCreated, 1, 'BrowserWindow is created once cookie restore completes');
  } finally {
    onCookieSetStarted = null;
    cookieSetGate = null;
    owner.dispose();
    foundation.stopSessionAutosave();
    await foundation.cookieJar.dispose();
    foundation.partition.dispose();
  }
});
