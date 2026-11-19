/**
 * The sender renderer: a hidden, trusted window of this app (its own page and
 * narrow preload, no remote content) that owns every RTCPeerConnection of the
 * live view. Created on demand and released after the last viewer leaves;
 * main stays the authority and the sender only reports.
 */
import { BrowserWindow, type IpcMainEvent, session } from 'electron';
import { tagRendererSurface } from '../process-memory-diagnostics';

import {
  REMOTE_WEBRTC_SENDER_IPC,
  type RemoteWebrtcSenderCommand,
  type RemoteWebrtcSenderEvent,
} from '../../shared/remote-webrtc-sender';
import { builtPreloadPath } from '../browser/preload-path';
import type { RemoteWebrtcSenderBridge } from './host';
import {
  installRemoteWebrtcSenderSession,
  REMOTE_WEBRTC_SENDER_PARTITION,
  type RemoteWebrtcSenderPage,
  remoteWebrtcSenderPageUrl,
} from './sender-session';

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

export type { RemoteWebrtcSenderPage };

export function createRemoteWebrtcSenderWindow(page: RemoteWebrtcSenderPage): RemoteWebrtcSenderBridge & {
  dispose(): void;
} {
  let window: BrowserWindow | null = null;
  let disposed = false;
  let policyInstalled = false;
  let ready = false;
  /** Commands sent before the page is ready, in order. */
  let queue: RemoteWebrtcSenderCommand[] = [];
  let listener: (event: RemoteWebrtcSenderEvent | null) => void = () => undefined;

  function release(destroy = true): void {
    const current = window;
    if (!current) return;
    window = null;
    ready = false;
    queue = [];
    if (destroy && !current.isDestroyed()) current.destroy();
    listener(null);
  }

  function open(): BrowserWindow {
    if (!policyInstalled) {
      policyInstalled = true;
      // The window's own session: screen capture needs the `media` grant the
      // default session reserves for app windows (sender-session.ts).
      installRemoteWebrtcSenderSession(session.fromPartition(REMOTE_WEBRTC_SENDER_PARTITION), page, () =>
        window && !window.isDestroyed() ? window.webContents : null
      );
    }
    const created = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 64,
      height: 64,
      title: 'Mixdog live view sender',
      webPreferences: {
        preload: builtPreloadPath('remote-webrtc-sender.js'),
        partition: REMOTE_WEBRTC_SENDER_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // Encoding and ICE keepalives must run while the window is hidden.
        backgroundThrottling: false,
      },
    });
    tagRendererSurface(created, 'remote-webrtc-sender');
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.ipc.on(REMOTE_WEBRTC_SENDER_IPC.event, (_event: IpcMainEvent, message: unknown) => {
      if (window !== created) return;
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
      if (window === created) release();
    });
    created.on('closed', () => {
      if (window === created) release(false);
    });
    const load = page.developmentUrl ? created.loadURL(remoteWebrtcSenderPageUrl(page)) : created.loadFile(page.file);
    load.catch(() => {
      if (window === created && !created.isDestroyed()) created.destroy();
    });
    return created;
  }

  return {
    send(command) {
      if (disposed) return;
      if (!window) {
        // Capture and drawn tracks can be set up before the first connection.
        // All other commands are for a sender that is already running.
        if (command.type !== 'open' && command.type !== 'source-capture' && command.type !== 'source-draw') return;
        window = open();
      }
      if (!ready) queue.push(command);
      else window.webContents.send(REMOTE_WEBRTC_SENDER_IPC.command, command);
    },
    release: () => release(),
    onEvent(next) {
      listener = next;
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
