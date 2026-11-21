// A window whose page lost its link to the Local Storage backend (preload/local-storage-link.ts tells why and how it is
// noticed). The page hands over everything it holds; its renderer process is replaced, because only a new process
// connects to the backend again; the new page takes the values back before it reads its storage.
import type { BrowserWindow, IpcMainEvent } from 'electron';

import { DESKTOP_IPC } from '../shared/contract-ipc';
import type { DesktopIpcMain } from './ipc';

type Entries = [string, string][];

export interface LocalStorageRescue {
  /** The page reported its link lost, with everything it holds; its renderer process is ended. */
  lost(entries: unknown): void;
  /** What a page of this window is to make its storage, until one says it did. */
  take(): Entries | null;
  /** A page made its storage the whole rescue. */
  restored(): void;
  /** Whether the renderer exit being handled follows a loss, whatever ended the process; true once per loss. The page
   *  is then loaded again, in a new process. */
  exited(): boolean;
}

export interface LocalStorageRescueDeps {
  /** Ends the window's renderer process. */
  endRenderer(): void;
  report(details: { keys: number; chars: number }): void;
}

const entriesOf = (value: unknown): Entries =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )
    : [];

export function createLocalStorageRescue(deps: LocalStorageRescueDeps): LocalStorageRescue {
  let held: Entries | null = null;
  let exiting = false;
  return {
    lost(entries) {
      // The page's report is the whole of what it holds: only a page whose storage is all of an earlier rescue is
      // watched.
      const rescue = entriesOf(entries);
      held = rescue;
      deps.report({
        keys: rescue.length,
        chars: rescue.reduce((sum, [key, value]) => sum + key.length + value.length, 0),
      });
      exiting = true;
      deps.endRenderer();
    },
    take: () => held,
    restored() {
      held = null;
    },
    exited() {
      const followsLoss = exiting;
      exiting = false;
      return followsLoss;
    },
  };
}

export function registerLocalStorageRescueIpc({
  window,
  ipcMain,
  rescue,
}: {
  window: BrowserWindow;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  rescue?: LocalStorageRescue;
}): () => void {
  const validSender = (event: IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  // The preload blocks on this call at every page load, so it is always answered. A window with no rescue (the capture
  // window) has nothing to give.
  const onTake = (event: IpcMainEvent): void => {
    event.returnValue = rescue && validSender(event) ? rescue.take() : null;
  };
  // The page blocks on this call too, and the answer to a loss is the end of its process: it runs nothing after what
  // it handed over. Only a call that is not acted on is answered.
  const onLost = (event: IpcMainEvent, entries: unknown): void => {
    if (rescue && validSender(event)) rescue.lost(entries);
    else event.returnValue = null;
  };
  const onRestored = (event: IpcMainEvent): void => {
    if (rescue && validSender(event)) rescue.restored();
  };
  ipcMain.on(DESKTOP_IPC.takeLocalStorageRescue, onTake);
  ipcMain.on(DESKTOP_IPC.localStorageLost, onLost);
  ipcMain.on(DESKTOP_IPC.localStorageRestored, onRestored);
  return () => {
    ipcMain.removeListener(DESKTOP_IPC.takeLocalStorageRescue, onTake);
    ipcMain.removeListener(DESKTOP_IPC.localStorageLost, onLost);
    ipcMain.removeListener(DESKTOP_IPC.localStorageRestored, onRestored);
  };
}
