import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron';

import { EngineHost } from './engine-host';
import { createDesktopDiagnostics, type DesktopDiagnostics } from './desktop-diagnostics';
import { registerDesktopIpc } from './ipc';
import { installNativeMenu } from './menu';
import { DesktopSettingsStore } from './settings-store';
import { TerminalManager } from './terminal-manager';
import { desktopUpdater, startAutoUpdater } from './updater';
import {
  DESKTOP_WINDOW_OPTIONS,
  configureTitleBarThemePersistence,
  initialTitleBarWindowOverrides,
  setDesktopTitleBarZoom,
} from './window-options';
import { DESKTOP_IPC } from '../shared/contract';
import { persistWindowState, readWindowState } from './window-state';

const acceptanceDebugPort = process.argv
  .find((argument) => argument.startsWith('--remote-debugging-port='))
  ?.slice('--remote-debugging-port='.length);
if (acceptanceDebugPort && /^\d+$/.test(acceptanceDebugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', acceptanceDebugPort);
}

const host = new EngineHost({
  getUserDataPath: () => app.getPath('userData'),
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
});
const settingsStore = new DesktopSettingsStore({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
});
let mainWindow: BrowserWindow | null = null;
let removeIpc: (() => void) | null = null;
const terminalManager = new TerminalManager();
let quitAfterDispose = false;
let disposalPromise: Promise<void> | null = null;
let windowState: ReturnType<typeof persistWindowState> | null = null;
let windowStateFlush: Promise<void> = Promise.resolve();
let diagnostics: DesktopDiagnostics | null = null;
let diagnosticsMemoryTimer: NodeJS.Timeout | null = null;

function currentProcessMemory() {
  try {
    return app.getAppMetrics().slice(0, 32).map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      serviceName: metric.serviceName,
      workingSetKb: metric.memory.workingSetSize,
      peakWorkingSetKb: metric.memory.peakWorkingSetSize,
      privateKb: metric.memory.privateBytes,
    }));
  } catch {
    return [];
  }
}

function disposeDesktopResources(): Promise<void> {
  if (diagnosticsMemoryTimer) {
    clearInterval(diagnosticsMemoryTimer);
    diagnosticsMemoryTimer = null;
  }
  if (!disposalPromise) diagnostics?.write('desktop-stop');
  terminalManager.disposeAll();
  disposalPromise ??= Promise.all([
    host.dispose(),
    windowStateFlush,
    windowState?.flush(),
    diagnostics?.flush(),
  ])
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error('Failed to dispose Mixdog engine during quit:', error);
    });
  return disposalPromise;
}

async function setPersistentZoom(factor: number): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const next = Math.min(10, Math.max(0.2, Math.round(factor * 100) / 100));
  window.webContents.setZoomFactor(next);
  setDesktopTitleBarZoom(window, next);
  const saved = await settingsStore.updateZoom(next);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, saved);
  }
}

function configuredDevelopmentUrl(candidate: string): URL {
  try {
    const url = new URL(candidate);
    const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!localHost || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error('Development renderer URL must use a local HTTP(S) origin.');
    }
    return url;
  } catch {
    throw new Error('Invalid local development renderer URL.');
  }
}

async function createWindow(): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const packagedRendererPath = join(__dirname, '../renderer/index.html');
  const rendererUrl = developmentUrl
    ? configuredDevelopmentUrl(developmentUrl)
    : new URL(pathToFileURL(packagedRendererPath).href);
  const isAllowedNavigation = (candidate: string): boolean => {
    try {
      const target = new URL(candidate);
      return developmentUrl
        ? target.origin === rendererUrl.origin
        : target.href === rendererUrl.href;
    } catch {
      return false;
    }
  };

  const statePath = join(app.getPath('userData'), 'window-state.json');
  const savedState = await readWindowState(statePath, screen.getAllDisplays());
  configureTitleBarThemePersistence(join(app.getPath('userData'), 'desktop-titlebar-theme'));
  const window = new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    ...initialTitleBarWindowOverrides(),
    ...(savedState?.bounds ?? {}),
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
    },
  });
  if (savedState?.maximized) window.maximize();
  windowState = persistWindowState(window, statePath);
  mainWindow = window;
  // Apply the persisted zoom BEFORE the first paint. It used to be applied by
  // the renderer's lazy getZoomFactor call a beat after the window appeared,
  // which rescaled the page and the titlebar overlay height in quick
  // succession — the visible double "pop" of the title tab on startup.
  const initialZoom = settingsStore ? await settingsStore.readZoom() : 1;
  if (initialZoom !== 1) {
    setDesktopTitleBarZoom(window, initialZoom);
    window.webContents.on('dom-ready', () => {
      window.webContents.setZoomFactor(initialZoom);
    });
  }
  removeIpc = registerDesktopIpc(window, host, {
    app,
    ipcMain,
    dialog,
    shell,
    settingsStore,
    updater: desktopUpdater,
    terminals: terminalManager,
  });
  diagnostics?.write('window-created');

  window.on('unresponsive', () => {
    diagnostics?.write('renderer-unresponsive', { processes: currentProcessMemory() });
  });
  window.on('responsive', () => {
    diagnostics?.write('renderer-responsive');
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.write('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      processes: currentProcessMemory(),
    });
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.once('ready-to-show', () => {
    window.show();
    startAutoUpdater(async () => {
      await disposeDesktopResources();
      quitAfterDispose = true;
    });
  });
  window.on('closed', () => {
    diagnostics?.write('window-closed');
    const state = windowState;
    windowState = null;
    windowStateFlush = state?.flush().finally(() => state.dispose()) ?? Promise.resolve();
    removeIpc?.();
    removeIpc = null;
    mainWindow = null;
  });

  try {
    if (developmentUrl) {
      await window.loadURL(rendererUrl.href);
    } else {
      await window.loadFile(packagedRendererPath);
    }
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    diagnostics = createDesktopDiagnostics(
      join(app.getPath('userData'), 'logs', 'desktop-diagnostics.jsonl'),
      { appVersion: app.getVersion(), packaged: app.isPackaged },
    );
    diagnostics.write('desktop-start', {
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
    });
    diagnosticsMemoryTimer = setInterval(() => {
      diagnostics?.write('process-memory', { processes: currentProcessMemory() });
    }, 5 * 60 * 1000);
    diagnosticsMemoryTimer.unref();
    app.on('child-process-gone', (_event, details) => {
      diagnostics?.write('child-process-gone', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name,
      });
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const development = Boolean(process.env.ELECTRON_RENDERER_URL);
      const policy = development
        ? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
        : "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    });
    // Push-to-talk dictation records via getUserMedia. Grant `media`
    // deterministically (goose desktop `main.ts` sets the same handler) and
    // log any other permission request so future surfaces fail loudly instead
    // of depending on Electron's default-allow behavior.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission !== 'media') {
        diagnostics?.write('permission-request', { permission });
      }
      callback(true);
    });
    await createWindow();
    // Keep the synchronous native-menu construction off the critical path to
    // the first renderer load. This matches the OpenCode startup ordering.
    installNativeMenu(Boolean(process.env.ELECTRON_RENDERER_URL), {
      reset: () => { void setPersistentZoom(1); },
      zoomIn: () => { void setPersistentZoom((mainWindow?.webContents.getZoomFactor() || 1) + 0.2); },
      zoomOut: () => { void setPersistentZoom((mainWindow?.webContents.getZoomFactor() || 1) - 0.2); },
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          console.error('Failed to recreate the Mixdog desktop window:', error);
        });
      }
    });
  }).catch((error: unknown) => {
    diagnostics?.write('desktop-initialize-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '',
    });
    console.error('Failed to initialize the Mixdog desktop window:', error);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (quitAfterDispose) return;
  event.preventDefault();
  removeIpc?.();
  removeIpc = null;
  void disposeDesktopResources().finally(() => {
      quitAfterDispose = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
