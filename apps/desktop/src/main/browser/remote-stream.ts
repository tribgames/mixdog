import type { WebContents } from 'electron';

import type {
  DesktopBrowserPageControl,
  DesktopBrowserPageDialog,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
  DesktopRemoteBrowserViewport,
} from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserLeaveConfirmation } from './leave-confirmation';
import type { BrowserRemoteDrive } from './remote-drive';
import type { SessionTabStrip } from './tabs-close-result';
import type { BrowserUrlPolicy } from './url-policy';

export interface BrowserRemoteControlHost {
  state: BrowserGuestStateStore;
  cdp: Pick<BrowserGuestCdp, 'call' | 'guestDebugger' | 'waitForInitialDocument'>;
  urlPolicy: BrowserUrlPolicy;
  ensureGuest(sessionId: string, options?: { reveal?: boolean; user?: boolean }): Promise<WebContents>;
  /** The page the session currently shows, or null when it has none. */
  currentGuest(sessionId: string): WebContents | null;
  /** A paired client started or stopped streaming this session; the display
   *  client keeps a watched guest where Chromium still composes frames. */
  viewerChanged?(sessionId: string, active: boolean): void;
  onUserControl?(guest: WebContents): void;
  /** Runs a person's request that may leave the page (see leave-confirmation). */
  leave?: Pick<BrowserLeaveConfirmation, 'request'>;
  /** The dialog a view of this page offers, as the local pane shows it; the
   *  client answers it through the pane's own answer path. */
  dialog?(guest: WebContents): DesktopBrowserPageDialog | undefined;
  assertResolvedUrlAllowed(url: string, pageGenerated: boolean): Promise<void>;
  /** The local pane's CDP input dispatch, under the caller's document guard. */
  dispatchPageInput(guest: WebContents, input: DesktopBrowserPageControl, assertCurrent: () => void): Promise<void>;
  /** Hands one frame to the service, which paces it per client. */
  publishFrame(frame: DesktopRemoteBrowserStreamFrame): Promise<void>;
  /** Renders a streamed page at the client's viewport, and restores the pane's. */
  drive?: Pick<BrowserRemoteDrive, 'apply' | 'restore'>;
  /** The session's tab strip, the very one the local pane shows and drives. */
  tabs?: SessionTabStrip;
}

/** Follows guest, tab and document changes while streaming. */
const STREAM_WATCH_MS = 150;

export interface PictureView {
  size: { width: number; height: number };
  viewport: { width: number; height: number };
}

export interface ScreencastRun {
  guest: WebContents;
  port: Electron.Debugger;
  documentId: string;
  size: string;
  listener(event: unknown, method: string, params: Record<string, unknown>, cdpSession?: string): void;
  /** This run's latest image: its size and the CSS viewport it depicted.
   *  Only it may be described — never an image of another page, document
   *  or size. */
  view: PictureView | null;
  detachGuest(): void;
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteStream {
  options: DesktopRemoteBrowserStreamOptions;
  seq: number;
  run: ScreencastRun | null;
  /** frameSignature of the last frame queued. */
  signature: string;
  checking: boolean;
  work: Promise<void>;
  expiry: ReturnType<typeof setTimeout>;
  watch: ReturnType<typeof setInterval>;
  pending: DesktopRemoteBrowserStreamFrame | null;
  lastPublishedAt: number;
  publishTimer: ReturnType<typeof setTimeout> | null;
  publishing: boolean;
  /** The viewport the client drives the page at, once it sent one. */
  viewport: DesktopRemoteBrowserViewport | null;
  /** The page and document that viewport was last applied to. */
  driven: { guest: WebContents; documentId: string; key: string } | null;
}

export const viewportKey = (viewport: DesktopRemoteBrowserViewport): string =>
  `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`;

/** Frame size plus driven viewport: a change to either restarts the screencast. */
export const sizeKey = (stream: Pick<RemoteStream, 'options' | 'viewport'>): string =>
  `${stream.options.maxWidth}x${stream.options.maxHeight}${stream.viewport ? `:${viewportKey(stream.viewport)}` : ''}`;

/** A fresh stream: `work` is what it must wait for, `onWatch` runs on every watch tick. */
export function createRemoteStream(
  options: DesktopRemoteBrowserStreamOptions,
  work: Promise<void>,
  onWatch: (stream: RemoteStream) => void
): RemoteStream {
  const created: RemoteStream = {
    options,
    seq: 0,
    run: null,
    signature: '',
    checking: false,
    work,
    expiry: setTimeout(() => undefined, 0),
    watch: setInterval(() => onWatch(created), STREAM_WATCH_MS),
    pending: null,
    lastPublishedAt: Number.NEGATIVE_INFINITY,
    publishTimer: null,
    publishing: false,
    viewport: null,
    driven: null,
  };
  created.watch.unref?.();
  return created;
}
