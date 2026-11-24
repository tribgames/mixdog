// The windows whose renderer keeps editor backups (the desktop preload's, which registerDesktopIpc serves), and a quit's
// request that each write its pending ones while the core still takes them. The renderer's answer waits for those writes.
// Only a window that can answer is asked, and a request ends with every state the window reports in which it cannot.
import type { WebContents } from 'electron';
import { DESKTOP_IPC } from '../shared/contract-ipc';

/** The part of a BrowserWindow the request uses. */
export interface EditorBackupWindow {
  isDestroyed(): boolean;
  webContents: Pick<WebContents, 'isDestroyed' | 'send' | 'on' | 'removeListener' | 'ipc'>;
}

interface Member {
  window: EditorBackupWindow;
  /** Its page finished loading and has not started leaving: the preload that answers is there. */
  loaded: boolean;
  responsive: boolean;
  /** The requests waiting on its answer. */
  waiting: Set<() => void>;
}

const members = new Set<Member>();
let nextRequest = 1;

/** Joins `window`, before its page loads; the disposer (its IPC scope's cleanup) takes it out again. */
export function joinEditorBackupFlush(window: EditorBackupWindow): () => void {
  const contents = window.webContents;
  const member: Member = { window, loaded: false, responsive: true, waiting: new Set() };
  const release = (): void => {
    for (const settle of [...member.waiting]) settle();
  };
  // A page that finished loading answers, whatever its predecessor was reported as: a reload after a hang brings no
  // `responsive` event.
  const loaded = (): void => {
    member.loaded = true;
    member.responsive = true;
  };
  const leaving = (): void => {
    member.loaded = false;
    release();
  };
  const navigating = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) leaving();
  };
  const failed = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean): void => {
    if (isMainFrame) leaving();
  };
  const unresponsive = (): void => {
    member.responsive = false;
    release();
  };
  const responsive = (): void => {
    member.responsive = true;
  };
  contents.on('did-finish-load', loaded);
  contents.on('did-start-navigation', navigating);
  contents.on('did-fail-load', failed);
  contents.on('unresponsive', unresponsive);
  contents.on('responsive', responsive);
  contents.on('render-process-gone', leaving);
  contents.on('destroyed', leaving);
  members.add(member);
  return () => {
    if (!members.delete(member)) return;
    release();
    contents.removeListener('did-finish-load', loaded);
    contents.removeListener('did-start-navigation', navigating);
    contents.removeListener('did-fail-load', failed);
    contents.removeListener('unresponsive', unresponsive);
    contents.removeListener('responsive', responsive);
    contents.removeListener('render-process-gone', leaving);
    contents.removeListener('destroyed', leaving);
  };
}

/** Asks every joined window that can answer to write its pending editor backups. Settles once each has answered or can
 *  no longer (it navigates, fails to load, is reported unresponsive, crashes or is destroyed); a window with nothing
 *  pending answers at once. */
export function flushEditorBackups(): Promise<void> {
  return Promise.all([...members].map(ask)).then(() => undefined);
}

function ask(member: Member): Promise<void> {
  const { window } = member;
  const contents = window.webContents;
  if (window.isDestroyed() || contents.isDestroyed() || !member.loaded || !member.responsive) return Promise.resolve();
  const request = nextRequest++;
  return new Promise((resolve) => {
    const settle = (): void => {
      member.waiting.delete(settle);
      contents.ipc.removeListener(DESKTOP_IPC.editorBackupsFlushed, answered);
      resolve();
    };
    const answered = (_event: unknown, answer: unknown): void => {
      if (answer === request) settle();
    };
    member.waiting.add(settle);
    contents.ipc.on(DESKTOP_IPC.editorBackupsFlushed, answered);
    contents.send(DESKTOP_IPC.flushEditorBackups, request);
  });
}
