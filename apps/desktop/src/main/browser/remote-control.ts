/**
 * The remote view of a session's visible page: while a paired client streams
 * the session, the current guest's Page screencast is forwarded as JPEG
 * frames, and the client's human input comes back document-bound.
 */
import type { WebContents } from 'electron';

import type {
  DesktopBrowserPageControl,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
} from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

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
  assertResolvedUrlAllowed(url: string, pageGenerated: boolean): Promise<void>;
  /** The local pane's CDP input dispatch, under the caller's document guard. */
  dispatchPageInput(guest: WebContents, input: DesktopBrowserPageControl, assertCurrent: () => void): Promise<void>;
  /** Hands one frame to the service, which paces it per client. */
  publishFrame(frame: DesktopRemoteBrowserStreamFrame): Promise<void>;
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

interface ScreencastRun {
  guest: WebContents;
  port: Electron.Debugger;
  documentId: string;
  size: string;
  listener(event: unknown, method: string, params: Record<string, unknown>, cdpSession?: string): void;
  gotFrame: boolean;
  /** pageSignature of the last frame sent for this run. */
  signature: string;
  detachGuest(): void;
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
}

interface RemoteStream {
  options: DesktopRemoteBrowserStreamOptions;
  seq: number;
  run: ScreencastRun | null;
  /** The last image's size and the CSS viewport it depicted. */
  lastView: { size: { width: number; height: number }; viewport: { width: number; height: number } } | null;
  checking: boolean;
  work: Promise<void>;
  expiry: ReturnType<typeof setTimeout>;
  watch: ReturnType<typeof setInterval>;
  pending: DesktopRemoteBrowserStreamFrame | null;
  lastPublishedAt: number;
  publishTimer: ReturnType<typeof setTimeout> | null;
  publishing: boolean;
}

export function createBrowserRemoteControl(host: BrowserRemoteControlHost) {
  const { state, cdp, urlPolicy, ensureGuest, assertResolvedUrlAllowed } = host;
  const streams = new Map<string, RemoteStream>();

  const sizeKey = (options: DesktopRemoteBrowserStreamOptions): string => `${options.maxWidth}x${options.maxHeight}`;

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
  function pageSignature(guest: WebContents, documentId: string): string {
    const history = guest.navigationHistory;
    return [
      documentId,
      guest.getURL(),
      guest.getTitle(),
      guest.isLoadingMainFrame(),
      history.canGoBack(),
      history.canGoForward(),
      state.peek(guest)?.pendingDialog ? 'dialog' : '',
      guest.getZoomFactor(),
    ].join('\u0000');
  }

  /** Queue a frame of the run's page; without `data` it carries metadata only. */
  function queueFrame(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    data: string | undefined,
    viewport: { width: number; height: number }
  ): void {
    const { guest } = run;
    if (stream.run !== run || guest.isDestroyed()) return;
    // A frame from before a navigation must not carry the new document's id.
    if (browserDocumentId(state, guest) !== run.documentId) return;
    const size = (data ? jpegSize(data) : null) ?? stream.lastView?.size ?? viewport;
    if (data) {
      run.gotFrame = true;
      stream.lastView = { size, viewport };
    }
    run.signature = pageSignature(guest, run.documentId);
    const history = guest.navigationHistory;
    stream.seq += 1;
    stream.pending = {
      sessionId,
      seq: stream.seq,
      frameId: `rbf_${stream.seq.toString(36)}`,
      documentId: run.documentId,
      url: guest.getURL() || 'about:blank',
      title: guest.getTitle(),
      loading: guest.isLoadingMainFrame(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      width: size.width,
      height: size.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      // A metadata-only frame must not discard an image still waiting to go out.
      ...(data
        ? { image: { mimeType: 'image/jpeg' as const, data } }
        : stream.pending?.image
          ? { image: stream.pending.image }
          : {}),
    };
    schedulePublish(stream);
  }

  const emitFrame = queueFrame;

  /** Reconcile the screencast, then push the page's facts if they changed. */
  async function check(sessionId: string, stream: RemoteStream): Promise<void> {
    if (stream.checking) return;
    stream.checking = true;
    try {
      await reconcile(sessionId, stream);
      const run = stream.run;
      if (!run || run.guest.isDestroyed() || streams.get(sessionId) !== stream) return;
      if (browserDocumentId(state, run.guest) !== run.documentId) return;
      // Before the first image there is no viewport to describe; it follows.
      if (!stream.lastView || pageSignature(run.guest, run.documentId) === run.signature) return;
      queueFrame(sessionId, stream, run, undefined, stream.lastView.viewport);
    } finally {
      stream.checking = false;
    }
  }

  async function captureFirstFrame(sessionId: string, stream: RemoteStream, run: ScreencastRun): Promise<void> {
    if (stream.run !== run || run.gotFrame) return;
    const metrics = await cdp.call<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
      run.guest,
      'Page.getLayoutMetrics'
    );
    const viewport = metrics.cssVisualViewport;
    if (!viewport?.clientWidth || !viewport.clientHeight) return;
    const scale = Math.min(1, stream.options.maxWidth / viewport.clientWidth, stream.options.maxHeight / viewport.clientHeight);
    const shot = await cdp.call<{ data: string }>(run.guest, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: STREAM_JPEG_QUALITY,
      clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale },
    });
    if (run.gotFrame) return;
    emitFrame(sessionId, stream, run, shot.data, { width: viewport.clientWidth, height: viewport.clientHeight });
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
    const size = sizeKey(stream.options);
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
    const run: ScreencastRun = {
      guest,
      port,
      documentId,
      size,
      gotFrame: false,
      signature: '',
      detachGuest: () => {
        for (const name of PAGE_EVENTS) (guest as NodeJS.EventEmitter).removeListener(name, onPageEvent);
      },
      firstFrameTimer: null,
      listener: (_event, method, params, cdpSession) => {
        if (cdpSession || method !== 'Page.screencastFrame' || stream.run !== run) return;
        // Acked at once: Chromium sends no further frame until this one is.
        void cdp.call(guest, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
        const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
        emitFrame(sessionId, stream, run, String(params.data ?? ''), {
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
    stream.work = stream.work.then(() => stopRun(stream)).catch(() => undefined);
    host.viewerChanged?.(sessionId, false);
  }

  function armExpiry(sessionId: string, stream: RemoteStream): void {
    clearTimeout(stream.expiry);
    stream.expiry = setTimeout(() => stopStream(sessionId), STREAM_EXPIRY_MS);
    // Presence is a display hint; it must never keep the process awake.
    stream.expiry.unref?.();
  }

  /** Start or renew (options) or stop (null) streaming a session's page. */
  async function remoteBrowserStream(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<void> {
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
        lastView: null,
        checking: false,
        work: Promise.resolve(),
        expiry: setTimeout(() => undefined, 0),
        watch: setInterval(() => void check(sessionId, created), STREAM_WATCH_MS),
        pending: null,
        lastPublishedAt: Number.NEGATIVE_INFINITY,
        publishTimer: null,
        publishing: false,
      };
      created.watch.unref?.();
      stream = created;
      streams.set(sessionId, stream);
      host.viewerChanged?.(sessionId, true);
    }
    stream.options = options;
    armExpiry(sessionId, stream);
    await reconcile(sessionId, stream);
  }

  /** The session is gone: stop streaming and release its viewer. */
  function releaseViewer(sessionId: string): void {
    stopStream(sessionId);
  }

  async function remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<void> {
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
    switch (control.type) {
      case 'navigate': {
        const url = normalizePageUrl(control.url, urlPolicy);
        await assertResolvedUrlAllowed(url, true);
        void guest.loadURL(url).catch(() => undefined);
        return;
      }
      case 'back':
        if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack();
        return;
      case 'forward':
        if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward();
        return;
      case 'reload':
        guest.reload();
        return;
      case 'stop':
        guest.stop();
        return;
    }
  }

  return { remoteBrowserStream, remoteBrowserControl, releaseViewer };
}
