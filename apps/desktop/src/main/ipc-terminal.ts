import type { BrowserWindow, IpcMainEvent } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';
import type { TerminalSizeOwnerEvent } from '../shared/terminal-size-owner';
import type { TerminalSpawnProfile } from './terminal-contract';
import { TerminalDataBufferer } from './terminal-data-buffer';
import type { DesktopIpcMain, IpcHandle as Handle } from './ipc';
import { requiredString } from './ipc-validation';

export interface DesktopTerminalHost {
  ensure(
    id: string | null,
    cwd: string | null,
    profile?: TerminalSpawnProfile | string | null
  ):
    | { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } }
    | Promise<{ id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  pauseOutput?(id: string): void;
  resumeOutput?(id: string): void;
  dispose(id: string): void;
  subscribe(listener: (event: { id: string; data: string }) => void): () => void;
  /** A phone claimed, released or lost the PTY size; the PC window follows or re-fits. */
  subscribeSizeOwner?(listener: (event: TerminalSizeOwnerEvent) => void): () => void;
}

interface TerminalIpcOptions {
  window: BrowserWindow;
  ipcMain: Pick<DesktopIpcMain, 'on' | 'removeListener'>;
  handle: Handle;
  terminals?: DesktopTerminalHost;
  terminalRuns?: { claim(requestId: string): boolean };
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
}

export function registerTerminalIpc({
  window,
  ipcMain,
  handle,
  terminals,
  terminalRuns,
  invokeDesktopOperation,
}: TerminalIpcOptions): () => void {
  const validSender = (event: IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const dataBuffer = new TerminalDataBufferer(
    (event) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.termData, event);
      }
    },
    5,
    256 * 1024,
    terminals
      ? {
          pause: (id) => terminals.pauseOutput?.(id),
          resume: (id) => terminals.resumeOutput?.(id),
        }
      : undefined,
    32 * 1024
  );

  if (terminals) {
    handle(DESKTOP_IPC.termEnsure, (_event, id, cwd, profile) =>
      terminals.ensure(
        typeof id === 'string' && id ? id : null,
        typeof cwd === 'string' && cwd ? cwd : null,
        typeof profile === 'string' && profile ? profile : null
      )
    );
    handle(DESKTOP_IPC.termProfiles, () => invokeDesktopOperation('termProfiles', []));
    handle(DESKTOP_IPC.termDispose, (_event, id) => {
      const terminalId = requiredString(id, 'terminal id', 128);
      dataBuffer.release(terminalId);
      terminals.dispose(terminalId);
    });
  }

  handle(DESKTOP_IPC.terminalRunClaim, (_event, requestId) =>
    terminalRuns?.claim(requiredString(requestId, 'terminal run request id', 128)) ?? false
  );

  const onWrite = (event: IpcMainEvent, id: unknown, data: unknown): void => {
    if (!validSender(event)) return;
    terminals?.write(String(id || ''), String(data ?? ''));
  };
  const onResize = (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown): void => {
    if (!validSender(event)) return;
    terminals?.resize(String(id || ''), Number(cols), Number(rows));
  };
  const onAcknowledge = (event: IpcMainEvent, id: unknown, charCount: unknown): void => {
    if (!validSender(event)) return;
    dataBuffer.acknowledge(String(id || ''), Number(charCount));
  };

  ipcMain.on(DESKTOP_IPC.termWrite, onWrite);
  ipcMain.on(DESKTOP_IPC.termResize, onResize);
  ipcMain.on(DESKTOP_IPC.termAcknowledge, onAcknowledge);
  const unsubscribe = terminals?.subscribe((event) => dataBuffer.push(event)) ?? (() => {});
  const unsubscribeSizeOwner =
    terminals?.subscribeSizeOwner?.((event) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.termSizeOwner, event);
      }
    }) ?? (() => {});

  return () => {
    unsubscribe();
    unsubscribeSizeOwner();
    dataBuffer.dispose();
    ipcMain.removeListener(DESKTOP_IPC.termWrite, onWrite);
    ipcMain.removeListener(DESKTOP_IPC.termResize, onResize);
    ipcMain.removeListener(DESKTOP_IPC.termAcknowledge, onAcknowledge);
  };
}
