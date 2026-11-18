// The window of main's confirm surface (developer-risk-confirm.ts): a hidden, frameless modal child of the asking
// window with its own narrow preload, no node integration, sandboxed, and no navigation or popups. Loaded on demand,
// so the IPC registration graph stays free of Electron values.
import { BrowserWindow, nativeTheme } from 'electron';
import { builtPreloadPath } from './browser/preload-path';

export const HOST_CONFIRM_WIDTH = 440;

export function openHostConfirmWindow(parent: BrowserWindow): BrowserWindow {
  const surface = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    width: HOST_CONFIRM_WIDTH,
    height: 200,
    title: parent.getTitle(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    webPreferences: {
      preload: builtPreloadPath('host-confirm.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
    },
  });
  surface.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  surface.webContents.on('will-navigate', (event) => event.preventDefault());
  return surface;
}
