/**
 * The remote view of a session's visible page: while a paired client streams
 * the session, the current guest's Page screencast is forwarded as JPEG
 * frames, and the client's human input comes back document-bound.
 */
import type { WebContents } from 'electron';

import type {
  DesktopBrowserPageControl,
  DesktopBrowserPageDialog,
  DesktopBrowserTabControlResult,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
  DesktopRemoteBrowserViewport,
} from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import type { BrowserRemoteDrive } from './remote-drive';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { controlSessionTab, isSessionTabControl, type SessionTabStrip } from './tabs-close-result';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';
import type { BrowserLeaveConfirmation } from './leave-confirmation';
import { navigatePage } from './page-surface-control';

interface BrowserRemoteControlHost {
  state: BrowserGuestStateStore;
  cdp: Pick<BrowserGuestCdp, 'call' | 'guestDebugger' | 'waitForInitialDocument'>;
  urlPolicy: BrowserUrlPolicy;
  ensureGuest(sessionId: string, options?: { reveal?: boolean }): Promise<WebContents>;
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

/** A subscription not renewed within this window ends the stream. */
const STREAM_EXPIRY_MS = 4_000;
/** Follows guest, tab and document changes while streaming. */
const STREAM_WATCH_MS = 150;
/** Guest events that change what a frame reports; each triggers an immediate check. */
const PAGE_EVENTS = [
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
  'did-start-loading',
  'did-stop-loading',
  'zoom-changed',
] as const;
const STREAM_MAX_FPS = 12;
const STREAM_FRAME_INTERVAL_MS = Math.ceil(1_000 / STREAM_MAX_FPS);
const STREAM_JPEG_QUALITY = 50;
/** A static page may never repaint; the first frame is then captured directly. */
const STREAM_FIRST_FRAME_MS = 300;

/** Pixel size of a JPEG, read from its start-of-frame marker. */
function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 65_536), 'base64');
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

interface PictureView {
  size: { width: number; height: number };
  viewport: { width: number; height: number };
}

interface ScreencastRun {
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

interface RemoteStream {
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

const viewportKey = (viewport: DesktopRemoteBrowserViewport): string =>
  `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}`;

export function createBrowserRemoteControl(host: BrowserRemoteControlHost) {
  const { state, cdp, urlPolicy, ensureGuest, assertResolvedUrlAllowed } = host;
  const streams = new Map<string, RemoteStream>();
  /** A stopped stream's teardown (screencast stop, pane restore) per session,
   *  until it settles: the session's next stream waits for it, so a stale
   *  restore can never undo the viewport a newer stream applied. */
  const teardowns = new Map<string, Promise<void>>();

  /** Frame size plus driven viewport: a change to either restarts the screencast. */
  const sizeKey = (stream: RemoteStream): string =>
    `${stream.options.maxWidth}x${stream.options.maxHeight}${stream.viewport ? `:${viewportKey(stream.viewport)}` : ''}`;

  function publishNow(stream: RemoteStream): void {
    stream.publishTimer = null;
    const frame = stream.pending;
    if (!frame || stream.publishing) return;
    stream.pending = null;
    stream.publishing = true;
    stream.lastPublishedAt = Date.now();
    void host
      .publishFrame(frame)
      .catch(() => undefined)
      .finally(() => {
        stream.publishing = false;
        // Whatever arrived while the service was busy goes out next, newest only.
        if (stream.pending) schedulePublish(stream);
      });
  }

  /** The newest frame replaces any waiting one; sends are capped at ~12/s. */
  function schedulePublish(stream: RemoteStream): void {
    if (stream.publishTimer || stream.publishing) return;
    const wait = Math.max(0, stream.lastPublishedAt + STREAM_FRAME_INTERVAL_MS - Date.now());
    if (wait === 0) publishNow(stream);
    else {
      stream.publishTimer = setTimeout(() => publishNow(stream), wait);
      stream.publishTimer.unref?.();
    }
  }

  /** Everything a frame reports besides pixels; a change pushes a frame. */
  function pageSignature(guest: WebContents, documentId: string, sessionId: string): string {
    const history = guest.navigationHistory;
    return [
      JSON.stringify(host.tabs?.list(sessionId) ?? []),
      documentId,
      guest.getURL(),
      guest.getTitle(),
      guest.isLoadingMainFrame(),
      history.canGoBack(),
      history.canGoForward(),
      host.dialog?.(guest)?.id ?? '',
      guest.getZoomFactor(),
    ].join('\u0000');
  }

  /** Queue a frame of a page's document: its facts, and the picture `view`
   *  describes (0×0 for none) with `image` when one goes out with it. */
  function composeFrame(
    sessionId: string,
    stream: RemoteStream,
    guest: WebContents,
    documentId: string,
    view: PictureView,
    image: DesktopRemoteBrowserStreamFrame['image']
  ): void {
    stream.signature = frameSignature(sessionId, guest, documentId, view);
    const history = guest.navigationHistory;
    const dialog = host.dialog?.(guest);
    stream.seq += 1;
    stream.pending = {
      sessionId,
      seq: stream.seq,
      frameId: `rbf_${stream.seq.toString(36)}`,
      documentId,
      url: guest.getURL() || 'about:blank',
      title: guest.getTitle(),
      loading: guest.isLoadingMainFrame(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      width: view.size.width,
      height: view.size.height,
      viewportWidth: view.viewport.width,
      viewportHeight: view.viewport.height,
      ...(host.tabs ? { tabs: host.tabs.list(sessionId) } : {}),
      ...(dialog ? { dialog } : {}),
      ...(image ? { image } : {}),
    };
    schedulePublish(stream);
  }

  /** Queue the run's image of its page. */
  function queueImage(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    data: string,
    viewport: { width: number; height: number }
  ): void {
    const { guest } = run;
    if (stream.run !== run || guest.isDestroyed()) return;
    // A frame from before a navigation must not carry the new document's id.
    if (browserDocumentId(state, guest) !== run.documentId) return;
    run.view = { size: jpegSize(data) ?? viewport, viewport };
    composeFrame(sessionId, stream, guest, run.documentId, run.view, { mimeType: 'image/jpeg', data });
  }

  const NO_PICTURE = { size: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } };

  /** Push the session page's facts if they changed. This needs no screencast
   *  and no debugger: a dialog may hold back painting, even debugger
   *  initialization, until the client answers the card these facts carry.
   *  The picture described is the image the screencast of this page, this
   *  document and the current size has sent, or none (0×0) until it sends
   *  one, so the client maps no input through the image it still shows. */
  function publishFacts(sessionId: string, stream: RemoteStream): void {
    if (streams.get(sessionId) !== stream) return;
    const guest = host.currentGuest(sessionId);
    if (!guest || guest.isDestroyed()) return;
    const documentId = browserDocumentId(state, guest);
    const run = stream.run;
    const live = run?.guest === guest && run.documentId === documentId && run.size === sizeKey(stream);
    const view = (live && run.view) || NO_PICTURE;
    if (frameSignature(sessionId, guest, documentId, view) === stream.signature) return;
    // A metadata-only frame must not discard an image still waiting to go out.
    const waiting = live && stream.pending?.documentId === documentId ? stream.pending.image : undefined;
    composeFrame(sessionId, stream, guest, documentId, view, waiting);
  }

  /** What a client is told besides pixels: the page's facts and the picture
   *  described — a resize that retires the picture is news too. */
  function frameSignature(
    sessionId: string,
    guest: WebContents,
    documentId: string,
    view: PictureView
  ): string {
    const picture = [view.size.width, view.size.height, view.viewport.width, view.viewport.height].join('x');
    return `${pageSignature(guest, documentId, sessionId)}\u0000${picture}`;
  }

  /** Push the page's facts, then reconcile the screencast and push what that changed. */
  async function check(sessionId: string, stream: RemoteStream): Promise<void> {
    publishFacts(sessionId, stream);
    if (stream.checking) return;
    stream.checking = true;
    try {
      await reconcile(sessionId, stream);
      publishFacts(sessionId, stream);
    } finally {
      stream.checking = false;
    }
  }

  async function captureFirstFrame(sessionId: string, stream: RemoteStream, run: ScreencastRun): Promise<void> {
    if (stream.run !== run || run.view) return;
    const metrics = await cdp.call<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
      run.guest,
      'Page.getLayoutMetrics'
    );
    const viewport = metrics.cssVisualViewport;
    if (!viewport?.clientWidth || !viewport.clientHeight) return;
    const scale = Math.min(
      1,
      stream.options.maxWidth / viewport.clientWidth,
      stream.options.maxHeight / viewport.clientHeight
    );
    const shot = await cdp.call<{ data: string }>(run.guest, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: STREAM_JPEG_QUALITY,
      clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale },
    });
    if (run.view) return;
    queueImage(sessionId, stream, run, shot.data, { width: viewport.clientWidth, height: viewport.clientHeight });
  }

  async function stopRun(stream: RemoteStream): Promise<void> {
    const run = stream.run;
    if (!run) return;
    stream.run = null;
    if (run.firstFrameTimer) clearTimeout(run.firstFrameTimer);
    run.port.removeListener('message', run.listener);
    run.detachGuest();
    if (!run.guest.isDestroyed()) await cdp.call(run.guest, 'Page.stopScreencast').catch(() => undefined);
  }

  /** Make the screencast match the session's current guest, document and size. */
  async function sync(sessionId: string, stream: RemoteStream): Promise<void> {
    if (streams.get(sessionId) !== stream) return;
    const guest = stream.run ? host.currentGuest(sessionId) : await ensureGuest(sessionId, { reveal: false });
    if (!guest || guest.isDestroyed()) {
      await stopRun(stream);
      return;
    }
    await cdp.waitForInitialDocument(guest);
    const port = await cdp.guestDebugger(guest);
    const documentId = browserDocumentId(state, guest);
    const size = sizeKey(stream);
    const current = stream.run;
    if (
      current &&
      current.guest === guest &&
      current.port === port &&
      current.documentId === documentId &&
      current.size === size
    ) {
      return;
    }
    await stopRun(stream);
    if (streams.get(sessionId) !== stream) return;
    if (current && current.size !== size) {
      // A frame captured at the old size must not reach the client as the new one.
      stream.pending = null;
    }
    // Every page, document and size change passes here, so a driven viewport
    // is re-applied before the new screencast captures anything.
    await driveGuest(sessionId, stream, guest, documentId);
    if (streams.get(sessionId) !== stream) return;
    const run: ScreencastRun = {
      guest,
      port,
      documentId,
      size,
      view: null,
      detachGuest: () => {
        for (const name of PAGE_EVENTS) (guest as NodeJS.EventEmitter).removeListener(name, onPageEvent);
      },
      firstFrameTimer: null,
      listener: (_event, method, params, cdpSession) => {
        if (cdpSession || method !== 'Page.screencastFrame' || stream.run !== run) return;
        // Acked at once: Chromium sends no further frame until this one is.
        void cdp.call(guest, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
        const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
        const data = String(params.data ?? '');
        if (!data) return;
        queueImage(sessionId, stream, run, data, {
          width: metadata.deviceWidth || 0,
          height: metadata.deviceHeight || 0,
        });
      },
    };
    const onPageEvent = () => void check(sessionId, stream);
    stream.run = run;
    port.on('message', run.listener);
    for (const name of PAGE_EVENTS) (guest as NodeJS.EventEmitter).on(name, onPageEvent);
    try {
      await cdp.call(guest, 'Page.startScreencast', {
        format: 'jpeg',
        quality: STREAM_JPEG_QUALITY,
        maxWidth: stream.options.maxWidth,
        maxHeight: stream.options.maxHeight,
      });
    } catch (error) {
      if (stream.run === run) {
        stream.run = null;
        port.removeListener('message', run.listener);
        run.detachGuest();
      }
      throw error;
    }
    run.firstFrameTimer = setTimeout(() => {
      run.firstFrameTimer = null;
      void captureFirstFrame(sessionId, stream, run).catch(() => undefined);
    }, STREAM_FIRST_FRAME_MS);
    run.firstFrameTimer.unref?.();
  }

  /** Apply the client's viewport to this page and document unless it already
   *  holds it; a page the stream left behind gets its pane's viewport back. */
  async function driveGuest(sessionId: string, stream: RemoteStream, guest: WebContents, documentId: string) {
    const viewport = stream.viewport;
    if (!host.drive || !viewport) return;
    const key = viewportKey(viewport);
    const previous = stream.driven;
    if (previous?.guest === guest && previous.documentId === documentId && previous.key === key) return;
    stream.driven = { guest, documentId, key };
    await host.drive.apply(sessionId, guest, viewport).catch(() => undefined);
    if (previous && previous.guest !== guest) await host.drive.restore(previous.guest).catch(() => undefined);
  }

  function reconcile(sessionId: string, stream: RemoteStream): Promise<void> {
    stream.work = stream.work.then(() => sync(sessionId, stream)).catch(() => undefined);
    return stream.work;
  }

  /** Nobody streams this session any more: stop composing frames for it. */
  function stopStream(sessionId: string): void {
    const stream = streams.get(sessionId);
    if (!stream) return;
    streams.delete(sessionId);
    clearTimeout(stream.expiry);
    clearInterval(stream.watch);
    if (stream.publishTimer) clearTimeout(stream.publishTimer);
    stream.pending = null;
    // An explicit stop and a lapsed lease alike hand the page back to its pane.
    const driven = stream.driven;
    stream.viewport = null;
    stream.driven = null;
    const teardown = stream.work
      .then(() => stopRun(stream))
      .then(() => (driven ? host.drive?.restore(driven.guest) : undefined))
      .catch(() => undefined)
      .finally(() => {
        if (teardowns.get(sessionId) === teardown) teardowns.delete(sessionId);
      });
    stream.work = teardown;
    teardowns.set(sessionId, teardown);
    host.viewerChanged?.(sessionId, false);
  }

  function armExpiry(sessionId: string, stream: RemoteStream): void {
    clearTimeout(stream.expiry);
    stream.expiry = setTimeout(() => stopStream(sessionId), STREAM_EXPIRY_MS);
    // Presence is a display hint; it must never keep the process awake.
    stream.expiry.unref?.();
  }

  /** Start or renew (options) or stop (null) streaming a session's page. */
  async function remoteBrowserStream(
    sessionId: string,
    options: DesktopRemoteBrowserStreamOptions | null
  ): Promise<void> {
    if (!options) {
      stopStream(sessionId);
      return;
    }
    let stream = streams.get(sessionId);
    if (!stream) {
      const created: RemoteStream = {
        options,
        seq: 0,
        run: null,
        signature: '',
        checking: false,
        // Starts only once the session's previous stream has handed its page back.
        work: teardowns.get(sessionId) ?? Promise.resolve(),
        expiry: setTimeout(() => undefined, 0),
        watch: setInterval(() => void check(sessionId, created), STREAM_WATCH_MS),
        pending: null,
        lastPublishedAt: Number.NEGATIVE_INFINITY,
        publishTimer: null,
        publishing: false,
        viewport: null,
        driven: null,
      };
      created.watch.unref?.();
      stream = created;
      streams.set(sessionId, stream);
      host.viewerChanged?.(sessionId, true);
    }
    stream.options = options;
    armExpiry(sessionId, stream);
    // The page's facts go first: starting the screencast may wait on the page.
    publishFacts(sessionId, stream);
    await reconcile(sessionId, stream);
  }

  /** The session is gone: stop streaming and release its viewer. */
  function releaseViewer(sessionId: string): void {
    stopStream(sessionId);
  }

  /** A dialog answer is not taken here: it goes the local pane's answer path. */
  async function remoteBrowserControl(
    sessionId: string,
    control: Exclude<DesktopRemoteBrowserControl, { type: 'answer-dialog' }>
  ): Promise<DesktopBrowserTabControlResult | void> {
    if (control.type === 'viewport') {
      // Only a streaming client drives the page; it resends with each renewal,
      // so a viewport for a lapsed stream is simply dropped.
      const stream = streams.get(sessionId);
      if (!stream) return;
      const viewport = { width: control.width, height: control.height, deviceScaleFactor: control.deviceScaleFactor };
      if (stream.viewport && viewportKey(stream.viewport) === viewportKey(viewport)) return;
      stream.viewport = viewport;
      await reconcile(sessionId, stream);
      return;
    }
    if (isSessionTabControl(control)) return controlSessionTab(host.tabs, sessionId, control);
    const guest = await ensureGuest(sessionId, { reveal: false });
    host.onUserControl?.(guest);
    if (
      control.type === 'pointer' ||
      control.type === 'wheel' ||
      control.type === 'text' ||
      control.type === 'key' ||
      control.type === 'composition' ||
      control.type === 'composition-end'
    ) {
      const assertCurrent = () => {
        if (
          guest.isDestroyed() ||
          state.for(guest).crashed ||
          host.currentGuest(sessionId) !== guest ||
          control.documentId !== browserDocumentId(state, guest)
        ) {
          throw new Error('Remote Browser Use page changed; input was not sent.');
        }
      };
      assertCurrent();
      await host.dispatchPageInput(guest, control, assertCurrent);
      return;
    }
    state.invalidateInteraction(guest);
    // A person on the paired client navigates the same way as at the pane.
    if (control.type === 'navigate') {
      const url = normalizePageUrl(control.url, urlPolicy);
      await assertResolvedUrlAllowed(url, true);
      navigatePage(host, guest, { type: 'navigate', url });
      return;
    }
    navigatePage(host, guest, control);
  }

  return { remoteBrowserStream, remoteBrowserControl, releaseViewer };
}
