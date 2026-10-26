/**
 * The remote view of a session's visible page: while a paired client streams
 * the session, the current guest's Page screencast is forwarded as JPEG
 * frames, and the client's human input comes back document-bound.
 */
import type {
  DesktopBrowserTabControlResult,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserStreamOptions,
} from '../../shared/contract';
import type { RemoteWebrtcGeometry, RemoteWebrtcResize, RemoteWebrtcVideoLimit } from '../../shared/remote-webrtc';
import { browserDocumentId } from './guest-state';
import { navigatePage } from './page-surface-control';
import { isPageInputControl, pageInputGuard } from './remote-input';
import { createRemoteStreamEngine } from './remote-stream-engine';
import { type BrowserRemoteControlHost, createRemoteStream, type RemoteStream, viewportKey } from './remote-stream';
import { controlSessionTab, isSessionTabControl } from './tabs-close-result';
import { normalizePageUrl } from './url-policy';

/** A subscription not renewed within this window ends the stream. */
const STREAM_EXPIRY_MS = 4_000;

type RemoteControl = Exclude<DesktopRemoteBrowserControl, { type: 'answer-dialog' }>;

export function createBrowserRemoteControl(host: BrowserRemoteControlHost) {
  const { state, urlPolicy, ensureGuest, assertResolvedUrlAllowed } = host;
  const streams = new Map<string, RemoteStream>();
  /** A stopped stream's teardown (screencast stop, pane restore) per session,
   *  until it settles: the session's next stream waits for it, so a stale
   *  restore can never undo the viewport a newer stream applied. */
  const teardowns = new Map<string, Promise<void>>();
  const { publishFacts, check, reconcile, stopRun } = createRemoteStreamEngine(host, streams);

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
    stream.viewport = null;
    const teardown = stream.work
      .then(() => stopRun(stream))
      .then(() => {
        // Read after the queued work: a fit being applied has landed by now.
        const driven = stream.driven;
        stream.driven = null;
        return driven ? host.drive?.restore(driven.guest) : undefined;
      })
      // Teardown is best effort: the page or its pane may already be gone.
      .catch(() => undefined)
      .finally(() => {
        if (teardowns.get(sessionId) === teardown) teardowns.delete(sessionId);
      });
    stream.work = teardown;
    teardowns.set(sessionId, teardown);
    host.geometryChanged?.(sessionId, null);
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
      // Starts only once the session's previous stream has handed its page back.
      stream = createRemoteStream(
        { maxWidth: options.maxWidth, maxHeight: options.maxHeight },
        teardowns.get(sessionId) ?? Promise.resolve(),
        (created) => void check(sessionId, created)
      );
      streams.set(sessionId, stream);
      host.viewerChanged?.(sessionId, true);
    }
    // A take-over fits the page once. Set before the stream's first capture,
    // the fit is emulated before the screencast starts, so the first frame and
    // geometry already show it. It then stays locked while any take-over
    // subscribes (the service passes `fit` exactly then): the keyboard,
    // panels and later fits never change it; only an explicit resize does.
    // When the last take-over leaves, the page gets its own geometry back
    // while watchers keep streaming; an explicit resize is kept.
    if (options.fit) {
      if (stream.layout === 'undecided') {
        stream.layout = 'takeover';
        stream.fitFailed = false;
        stream.viewport = options.fit;
      }
    } else if (stream.layout === 'takeover') {
      stream.layout = 'undecided';
      stream.fitFailed = false;
      unfit(stream);
    }
    // The frame bound is the one the stream started with: a renewal (the
    // keyboard, a rotation) never restarts the capture or changes its size.
    armExpiry(sessionId, stream);
    // The page's facts go first: starting the screencast may wait on the page.
    publishFacts(sessionId, stream);
    await reconcile(sessionId, stream);
  }

  /** Drop the stream's fit: the fitted page gets its own metrics and zoom
   *  back (no reload), and the next sync captures it as it is. */
  function unfit(stream: RemoteStream): void {
    stream.viewport = null;
    // Queued behind a sync that may be applying the fit right now; reads what
    // it left applied, and leaves it if a new fit was asked for meanwhile.
    stream.work = stream.work
      .then(() => {
        const driven = stream.driven;
        if (!driven || stream.viewport) return;
        stream.driven = null;
        return host.drive?.restore(driven.guest);
      })
      .catch(() => undefined);
  }

  /** The session is gone: stop streaming and release its viewer. */
  function releaseViewer(sessionId: string): void {
    stopStream(sessionId);
  }

  /** An explicit resize of a streamed page (`resize-request`): fit it to the
   *  client's box, or return it to its own geometry — by viewport emulation
   *  only, as a take-over fits, so the page never reloads. The page re-lays
   *  out and the stream locks a new geometry generation from its next frame.
   *  A resize for a lapsed stream is dropped. */
  async function resize(sessionId: string, request: RemoteWebrtcResize): Promise<void> {
    const stream = streams.get(sessionId);
    if (!stream) return;
    stream.layout = 'explicit';
    stream.fitFailed = false;
    if (request.mode === 'fit-client') {
      const viewport = {
        width: request.cssWidth,
        height: request.cssHeight,
        deviceScaleFactor: request.deviceScaleFactor,
      };
      if (stream.viewport && viewportKey(stream.viewport) === viewportKey(viewport)) return;
      stream.viewport = viewport;
    } else {
      if (!stream.viewport) return;
      // Explicitly back to the page's own geometry, without a reload.
      unfit(stream);
    }
    await reconcile(sessionId, stream);
  }

  /** A WebRTC viewer's video limit: when it exceeds the frame bound the stream
   *  started with, the capture widens to it and the next frame locks a new
   *  geometry generation (JPEG frames grow with it). Never shrinks. */
  function widenVideo(sessionId: string, limit: RemoteWebrtcVideoLimit): void {
    const stream = streams.get(sessionId);
    if (!stream) return;
    const maxWidth = Math.max(stream.options.maxWidth, limit.maxWidth);
    const maxHeight = Math.max(stream.options.maxHeight, limit.maxHeight);
    if (maxWidth === stream.options.maxWidth && maxHeight === stream.options.maxHeight) return;
    stream.options = { maxWidth, maxHeight };
    stream.geometry = null;
    void reconcile(sessionId, stream);
  }

  /** The session's streamed page as WebRTC sees it (document and locked
   *  geometry), or null while no client streams the session. */
  function streamedPage(
    sessionId: string
  ): { documentId: string | null; geometry: RemoteWebrtcGeometry | null } | null {
    const stream = streams.get(sessionId);
    if (!stream) return null;
    const guest = host.currentGuest(sessionId);
    return {
      documentId: guest && !guest.isDestroyed() ? browserDocumentId(state, guest) : null,
      geometry: stream.geometry?.geometry ?? null,
    };
  }

  /** A dialog answer is not taken here: it goes the local pane's answer path. */
  async function remoteBrowserControl(
    sessionId: string,
    control: RemoteControl
  ): Promise<DesktopBrowserTabControlResult | void> {
    // The client's own viewport is presentation: the page keeps its geometry
    // (keyboard, rotation and pane size never re-lay it out). Only an explicit
    // resize-request changes it.
    if (control.type === 'viewport') return;
    if (isSessionTabControl(control)) return controlSessionTab(host.tabs, sessionId, control);
    const guest = await ensureGuest(sessionId, { reveal: false, user: control.type === 'navigate' });
    host.onUserControl?.(guest);
    if (isPageInputControl(control)) {
      const assertCurrent = pageInputGuard(state, host, sessionId, guest, control.documentId);
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

  return { remoteBrowserStream, remoteBrowserControl, releaseViewer, resize, streamedPage, widenVideo };
}
