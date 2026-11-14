import type { BrowserWindow, IpcMainEvent } from 'electron';
import type { UiTerminalRunClaimedParams } from '../../../../packages/protocol/src/index.ts';
import { DESKTOP_IPC } from '../shared/contract';
import type { TerminalSizeOwnerEvent } from '../shared/terminal-size-owner';
import type { TerminalActivityEvent } from '../shared/terminal-activity';
import { TerminalDataBufferer } from './terminal-data-buffer';
import type { DesktopIpcMain, IpcHandle as Handle } from './ipc';
import { requiredString } from './ipc-validation';

export interface DesktopTerminalHost {
  ensure(
    id: string | null,
    cwd: string | null,
    profile?: string | null
  ):
    | { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } }
    | Promise<{ id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } }>;
  /** A running PTY's replay, or null when it is not running; never spawns. */
  attach?(
    id: string
  ): Promise<{ id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } } | null>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** `holder` is the window whose buffer is full: the tab's output stays paused until every holder has resumed or been released. */
  pauseOutput?(id: string, holder: string): void;
  resumeOutput?(id: string, holder: string): void;
  /** A window that is gone resumes every tab it was holding. */
  releaseHolder?(holder: string): void;
  dispose(id: string): void;
  subscribe(listener: (event: { id: string; data: string }) => void): () => void;
  /** A tab's feed was attached again after a link loss with the screen as it is now, not the frames missed: draw `replay` anew. */
  subscribeReset?(listener: (event: { id: string; replay: string }) => void): () => void;
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
  /** A client notification to the core, over this window's protocol link. */
  notify?: (method: typeof UI_TERMINAL_RUN_CLAIMED, params: UiTerminalRunClaimedParams) => void;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
}

export const UI_TERMINAL_RUN_CLAIMED = 'ui/terminalRun/claimed';

export function registerTerminalIpc({
  window,
  ipcMain,
  handle,
  terminals,
  notify,
  invokeDesktopOperation,
}: TerminalIpcOptions): () => void {
  const validSender = (event: IpcMainEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const sendToWindow = (channel: string, event: unknown): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, event);
  };
  const holder = `wc:${window.webContents.id}`;
  // The tabs this window shows (its ensure or attach was answered, its dispose has not come): another window's tab is not sent here.
  const shown = new Set<string>();
  const dataBuffer = new TerminalDataBufferer(
    (event) => sendToWindow(DESKTOP_IPC.termData, event),
    5,
    256 * 1024,
    terminals
      ? {
          pause: (id) => terminals.pauseOutput?.(id, holder),
          resume: (id) => terminals.resumeOutput?.(id, holder),
        }
      : undefined,
    32 * 1024
  );

  if (terminals) {
    handle(DESKTOP_IPC.termEnsure, async (_event, id, cwd, profile) => {
      const tabId = typeof id === 'string' && id ? id : null;
      // A tab this window names is shown from the request: its output between the core's attach and this answer is not lost.
      if (tabId) shown.add(tabId);
      const session = await terminals.ensure(
        tabId,
        typeof cwd === 'string' && cwd ? cwd : null,
        typeof profile === 'string' && profile ? profile : null
      );
      shown.add(session.id);
      return session;
    });
    handle(DESKTOP_IPC.termAttach, async (_event, id) => {
      const session = (await terminals.attach?.(requiredString(id, 'terminal id', 128))) ?? null;
      if (session) shown.add(session.id);
      return session;
    });
    handle(DESKTOP_IPC.termProfiles, () => invokeDesktopOperation('termProfiles', []));
    handle(DESKTOP_IPC.termActivity, () => terminals.activity?.() ?? []);
    handle(DESKTOP_IPC.termDispose, (_event, id) => {
      const terminalId = requiredString(id, 'terminal id', 128);
      shown.delete(terminalId);
      dataBuffer.release(terminalId);
      terminals.dispose(terminalId);
    });
  }

  // The core waits on the claim; true means it was sent (the core settles the run once, an unknown id is a no-op).
  handle(DESKTOP_IPC.terminalRunClaim, (_event, requestId) => {
    const claimed: UiTerminalRunClaimedParams = {
      requestId: requiredString(requestId, 'terminal run request id', 128),
    };
    if (!notify) return false;
    notify(UI_TERMINAL_RUN_CLAIMED, claimed);
    return true;
  });

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
  const unsubscribe =
    terminals?.subscribe((event) => {
      if (shown.has(event.id)) dataBuffer.push(event);
    }) ?? (() => {});
  const unsubscribeReset =
    terminals?.subscribeReset?.((event) => {
      if (shown.has(event.id)) dataBuffer.reset(event.id, event.replay);
    }) ?? (() => {});
  const unsubscribeSizeOwner =
    terminals?.subscribeSizeOwner?.((event) => sendToWindow(DESKTOP_IPC.termSizeOwner, event)) ?? (() => {});
  const unsubscribeActivity =
    terminals?.subscribeActivity?.((event) => sendToWindow(DESKTOP_IPC.termActivityChanged, event)) ?? (() => {});

  return () => {
    unsubscribe();
    unsubscribeReset();
    unsubscribeSizeOwner();
    unsubscribeActivity();
    dataBuffer.dispose();
    // The buffer resumed what it paused; a hold it never took back (a tab gone while paused) goes with the window.
    terminals?.releaseHolder?.(holder);
    ipcMain.removeListener(DESKTOP_IPC.termWrite, onWrite);
    ipcMain.removeListener(DESKTOP_IPC.termResize, onResize);
    ipcMain.removeListener(DESKTOP_IPC.termAcknowledge, onAcknowledge);
    ipcMain.removeListener(DESKTOP_IPC.termFocus, onFocus);
  };
}
