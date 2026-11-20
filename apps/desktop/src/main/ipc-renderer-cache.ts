// A window's large caches (shared/renderer-cache.ts), kept by the main process. They do not live in Local Storage:
// a cache of hundreds of kilobytes is rewritten whole each time it changes, and every write of a value there is copied
// into the renderer's storage cache and sent whole to the storage backend. Nor is each change written to disk: a cache
// is read once, by the first paint of the window's next page, so the page's latest text is held here and written to its
// profile file once, when the window is done with it.
import { readFileSync } from 'node:fs';

import type { BrowserWindow, IpcMainEvent } from 'electron';

import { writeFileAtomicSync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { DESKTOP_IPC } from '../shared/contract-ipc';
import { isRendererCacheName, type RendererCacheName } from '../shared/renderer-cache';
import type { DesktopIpcMain } from './ipc';

export interface RendererCache {
  /** The text the page last sent, or else the file's; null when there is neither. */
  read(): string | null;
  /** Holds the page's latest text. */
  write(text: string): void;
  /** Writes the text held since the file was last written. */
  save(): void;
}

export type RendererCaches = Record<RendererCacheName, RendererCache>;

export function createRendererCache(
  filePath: string,
  onFailure: (stage: 'read' | 'write', error: unknown) => void
): RendererCache {
  let unsaved: string | null = null;
  return {
    read() {
      if (unsaved !== null) return unsaved;
      try {
        return readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onFailure('read', error);
        return null;
      }
    },
    write(text) {
      unsaved = text;
    },
    save() {
      if (unsaved === null) return;
      try {
        // One attempt: this runs on the main thread as a window closes, and a destination another program holds for
        // a moment is not worth a wait for a cache.
        writeFileAtomicSync(filePath, unsaved, { backoffs: [] });
        unsaved = null;
      } catch (error) {
        onFailure('write', error);
      }
    },
  };
}

/** Serves the window's caches to its page. The returned function ends that, when the window closes or the app quits,
 *  and saves each cache. */
export function registerRendererCacheIpc({
  window,
  ipcMain,
  caches,
}: {
  window: BrowserWindow;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  caches?: RendererCaches;
}): () => void {
  const cacheOf = (event: IpcMainEvent, name: unknown): RendererCache | undefined =>
    caches &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isRendererCacheName(name)
      ? caches[name]
      : undefined;
  // The renderer blocks on this call, so it is always answered. A window with no caches (the capture window) has
  // none to give.
  const onRead = (event: IpcMainEvent, name: unknown): void => {
    event.returnValue = cacheOf(event, name)?.read() ?? null;
  };
  const onWrite = (event: IpcMainEvent, name: unknown, text: unknown): void => {
    if (typeof text === 'string') cacheOf(event, name)?.write(text);
  };
  ipcMain.on(DESKTOP_IPC.readRendererCache, onRead);
  ipcMain.on(DESKTOP_IPC.writeRendererCache, onWrite);
  return () => {
    ipcMain.removeListener(DESKTOP_IPC.readRendererCache, onRead);
    ipcMain.removeListener(DESKTOP_IPC.writeRendererCache, onWrite);
    for (const cache of Object.values(caches ?? {})) cache.save();
  };
}
