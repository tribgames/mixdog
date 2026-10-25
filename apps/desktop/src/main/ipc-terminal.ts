import type { BrowserWindow, IpcMainEvent } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';
import type { TerminalSizeOwnerEvent } from '../shared/terminal-size-owner';
import type { TerminalActivityEvent } from '../shared/terminal-activity';
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
  /** A running PTY's replay, or null when it is not running; never spawns. */
  attach?(
    id: string
  ): Promise<{ id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } } | null>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  pauseOutput?(id: string): void;
  resumeOutput?(id: string): void;
  dispose(id: string): void;
  subscribe(listener: (event: { id: string; data: string }) => void): () => void;
  /** A phone claimed, released or lost the PTY size; the PC window follows or re-fits. */
  subscribeSizeOwner?(listener: (event: TerminalSizeOwnerEvent) => void): () => void;
  /** Command activity (terminal-activity.ts): this window focused or left a tab. */
  focus?(id: string, focused: boolean): void;
  activity?(): Promise<TerminalActivityEvent[]>;
  subscribeActivity?(listener: (event: TerminalActivityEvent) => void): () => void;
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
  const sendToWindow = (channel: string, event: unknown): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, event);
  };
  const dataBuffer = new TerminalDataBufferer(
    (event) => sendToWindow(DESKTOP_IPC.termData, event),
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
    handle(DESKTOP_IPC.termAttach, (_event, id) => terminals.attach?.(requiredString(id, 'terminal id', 128)) ?? null);
    handle(DESKTOP_IPC.termProfiles, () => invokeDesktopOperation('termProfiles', []));
    handle(DESKTOP_IPC.termActivity, () => terminals.activity?.() ?? []);
    handle(DESKTOP_IPC.termDispose, (_event, id) => {
      const terminalId = requiredString(id, 'terminal id', 128);
      dataBuffer.release(terminalId);
      terminals.dispose(terminalId);
    });
  }

  handle(
    DESKTOP_IPC.terminalRunClaim,
    (_event, requestId) => terminalRuns?.claim(requiredString(requestId, 'terminal run request id', 128)) ?? false
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
  const onFocus = (event: IpcMainEvent, id: unknown, focused: unknown): void => {
    if (!validSender(event) || typeof id !== 'string' || !id) return;
    terminals?.focus?.(id, focused === true);
  };

  ipcMain.on(DESKTOP_IPC.termWrite, onWrite);
  ipcMain.on(DESKTOP_IPC.termResize, onResize);
  ipcMain.on(DESKTOP_IPC.termAcknowledge, onAcknowledge);
  ipcMain.on(DESKTOP_IPC.termFocus, onFocus);
  const unsubscribe = terminals?.subscribe((event) => dataBuffer.push(event)) ?? (() => {});
  const unsubscribeSizeOwner =
    terminals?.subscribeSizeOwner?.((event) => sendToWindow(DESKTOP_IPC.termSizeOwner, event)) ?? (() => {});
  const unsubscribeActivity =
    terminals?.subscribeActivity?.((event) => sendToWindow(DESKTOP_IPC.termActivityChanged, event)) ?? (() => {});

  return () => {
    unsubscribe();
    unsubscribeSizeOwner();
    unsubscribeActivity();
    dataBuffer.dispose();
    ipcMain.removeListener(DESKTOP_IPC.termWrite, onWrite);
    ipcMain.removeListener(DESKTOP_IPC.termResize, onResize);
    ipcMain.removeListener(DESKTOP_IPC.termAcknowledge, onAcknowledge);
    ipcMain.removeListener(DESKTOP_IPC.termFocus, onFocus);
  };
}
