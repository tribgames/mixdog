import { readFileSync } from 'node:fs';

import type { BrowserWindow, IpcMainEvent } from 'electron';

import { writeFileAtomicAsync, writeFileAtomicSync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { DESKTOP_IPC } from '../shared/contract-ipc';
import { isRendererCacheName, type RendererCacheName } from '../shared/renderer-cache';
import type { DesktopIpcMain } from './ipc';

export interface RendererCache {
  /** The file's text, or null when missing. */
  read(): string | null;
  /** Coalesces updates and persists them asynchronously, retaining nothing once written. */
  write(text: string): void;
  /** Synchronously flushes any dirty write on shutdown. */
  save(): void;
  /** Resolves once queued background writes finish. */
  flush(): Promise<void>;
}

export type RendererCaches = Record<RendererCacheName, RendererCache>;

export interface RendererCacheIo {
  writeAsync?: typeof writeFileAtomicAsync;
  writeSync?: typeof writeFileAtomicSync;
}

const ASYNC_WRITE_BACKOFFS = [15, 40];
const SYNC_SAVE_BACKOFFS = [15, 40, 100];

export function createRendererCache(
  filePath: string,
  onFailure: (stage: 'read' | 'write', error: unknown) => void,
  io?: RendererCacheIo
): RendererCache {
  const writeAsync = io?.writeAsync ?? writeFileAtomicAsync;
  const writeSync = io?.writeSync ?? writeFileAtomicSync;
  let generation = 0;
  let pending: { gen: number; text: string } | null = null;
  let inFlight: { gen: number; text: string } | null = null;
  // Set when a synchronous save() commits a newer generation while an older async write is still
  // in flight: once the older async write settles, drain() re-persists this text so a late rename
  // cannot leave stale data on disk.
  let reconcile: { gen: number; text: string } | null = null;
  let savedGen = 0;
  let drainPromise: Promise<void> | null = null;

  const scheduleDrain = (): void => {
    if (drainPromise) return;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null;
        if (pending !== null || reconcile !== null) scheduleDrain();
      });
  };

  async function drain(): Promise<void> {
    while (pending !== null || reconcile !== null) {
      const current = pending ?? reconcile;
      if (!current) break;
      pending = null;
      reconcile = null;
      inFlight = current;
      try {
        await writeAsync(filePath, current.text, { backoffs: ASYNC_WRITE_BACKOFFS });
      } catch (error) {
        if (savedGen < current.gen && generation === current.gen) onFailure('write', error);
      } finally {
        if (inFlight === current) inFlight = null;
      }
    }
  }

  return {
    read() {
      if (pending !== null) return pending.text;
      if (reconcile !== null) return reconcile.text;
      if (inFlight !== null) return inFlight.text;
      try {
        return readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onFailure('read', error);
        return null;
      }
    },
    write(text) {
      generation += 1;
      pending = { gen: generation, text };
      reconcile = null;
      scheduleDrain();
    },
    save() {
      const dirty = pending ?? reconcile ?? inFlight;
      pending = null;
      reconcile = null;
      if (dirty === null) return;
      try {
        writeSync(filePath, dirty.text, { backoffs: SYNC_SAVE_BACKOFFS });
        savedGen = Math.max(savedGen, dirty.gen);
        if (inFlight !== null && inFlight.gen < dirty.gen) {
          reconcile = dirty;
          scheduleDrain();
        }
      } catch (error) {
        onFailure('write', error);
      }
    },
    flush() {
      return drainPromise ?? Promise.resolve();
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
