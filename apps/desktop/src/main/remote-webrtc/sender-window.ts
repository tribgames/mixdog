/**
 * The sender renderer: a hidden, trusted window of this app (its own page and
 * narrow preload, no remote content) that owns every RTCPeerConnection of the
 * live view. Created on first use, recreated after a crash; main stays the
 * authority and the sender only reports.
 */
import { BrowserWindow, type IpcMainEvent } from 'electron';

import {
  REMOTE_WEBRTC_SENDER_IPC,
  type RemoteWebrtcSenderCommand,
  type RemoteWebrtcSenderEvent,
} from '../../shared/remote-webrtc-sender';
import { builtPreloadPath } from '../browser/preload-path';
import type { RemoteWebrtcSenderBridge } from './host';

const SENDER_EVENTS: ReadonlySet<string> = new Set([
  'ready',
  'offer',
  'candidate',
  'connected',
  'failed',
  'channel',
  'stats',
  'frame-done',
  'source-captured',
]);

/** Load target of the sender page: the dev server's, or the built file. */
export interface RemoteWebrtcSenderPage {
  developmentUrl?: string;
  /** Absolute path of the built remote-webrtc-sender.html. */
  file: string;
}

export function createRemoteWebrtcSenderWindow(page: RemoteWebrtcSenderPage): RemoteWebrtcSenderBridge & {
  dispose(): void;
} {
  let window: BrowserWindow | null = null;
  let ready = false;
  /** Commands sent before the page is ready, in order. */
  let queue: RemoteWebrtcSenderCommand[] = [];
  let listener: (event: RemoteWebrtcSenderEvent | null) => void = () => undefined;

  function gone(): void {
    window = null;
    ready = false;
    queue = [];
    listener(null);
  }

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 64,
      height: 64,
      title: 'Mixdog live view sender',
      webPreferences: {
        preload: builtPreloadPath('remote-webrtc-sender.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Encoding and ICE keepalives must run while the window is hidden.
        backgroundThrottling: false,
      },
    });
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.ipc.on(REMOTE_WEBRTC_SENDER_IPC.event, (_event: IpcMainEvent, message: unknown) => {
      const event = message as RemoteWebrtcSenderEvent | null;
      if (!event || typeof event !== 'object' || !SENDER_EVENTS.has(String(event.type))) return;
      if (event.type === 'ready') {
        ready = true;
        const waiting = queue;
        queue = [];
        for (const command of waiting) contents.send(REMOTE_WEBRTC_SENDER_IPC.command, command);
      }
      listener(event);
    });
    contents.on('render-process-gone', () => {
      if (window === created) {
        gone();
        if (!created.isDestroyed()) created.destroy();
      }
    });
    created.on('closed', () => {
      if (window === created) gone();
    });
    const load = page.developmentUrl
      ? created.loadURL(new URL('remote-webrtc-sender.html', page.developmentUrl).href)
      : created.loadFile(page.file);
    load.catch(() => {
      if (window === created && !created.isDestroyed()) created.destroy();
    });
    return created;
  }

  return {
    send(command) {
      // Nothing to close or feed in a sender that is not running.
      if (!window && (command.type === 'close' || command.type === 'source-close' || command.type === 'frame')) {
        return;
      }
      window ??= open();
      if (!ready) queue.push(command);
      else window.webContents.send(REMOTE_WEBRTC_SENDER_IPC.command, command);
    },
    onEvent(next) {
      listener = next;
    },
    dispose() {
      const current = window;
      window = null;
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
