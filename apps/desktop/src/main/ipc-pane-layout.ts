import type { BrowserWindow, IpcMainEvent } from 'electron';
import { DESKTOP_IPC } from '../shared/contract-ipc';
import type { DesktopIpcMain } from './ipc';
import type { PaneLayoutFile } from './pane-layout-file';

/** The window's pane layout file: the renderer reads it once, synchronously,
 *  when its own copy has no layout, and mirrors every layout it persists. */
export function registerPaneLayoutIpc({
  window,
  ipcMain,
  file,
}: {
  window: BrowserWindow;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  file?: PaneLayoutFile;
}): () => void {
  const validSender = (event: IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  // The renderer blocks on this call, so it is always answered. A window with
  // no file (the capture window) has no layout to give.
  const onRead = (event: IpcMainEvent): void => {
    event.returnValue = file && validSender(event) ? file.read() : null;
  };
  const onWrite = (event: IpcMainEvent, layout: unknown): void => {
    if (file && validSender(event) && typeof layout === 'string') file.write(layout);
  };
  ipcMain.on(DESKTOP_IPC.readPaneLayoutFile, onRead);
  ipcMain.on(DESKTOP_IPC.writePaneLayoutFile, onWrite);
  return () => {
    ipcMain.removeListener(DESKTOP_IPC.readPaneLayoutFile, onRead);
    ipcMain.removeListener(DESKTOP_IPC.writePaneLayoutFile, onWrite);
  };
}
