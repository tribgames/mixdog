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
    const driven = stream.driven;
    stream.viewport = null;
    stream.driven = null;
    const teardown = stream.work
      .then(() => stopRun(stream))
      .then(() => (driven ? host.drive?.restore(driven.guest) : undefined))
      // Teardown is best effort: the page or its pane may already be gone.
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
      // Starts only once the session's previous stream has handed its page back.
      stream = createRemoteStream(
        options,
        teardowns.get(sessionId) ?? Promise.resolve(),
        (created) => void check(sessionId, created)
      );
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

  /** Only a streaming client drives the page; it resends with each renewal,
   *  so a viewport for a lapsed stream is simply dropped. */
  async function applyViewport(
    sessionId: string,
    control: Extract<RemoteControl, { type: 'viewport' }>
  ): Promise<void> {
    const stream = streams.get(sessionId);
    if (!stream) return;
    const viewport = { width: control.width, height: control.height, deviceScaleFactor: control.deviceScaleFactor };
    if (stream.viewport && viewportKey(stream.viewport) === viewportKey(viewport)) return;
    stream.viewport = viewport;
    await reconcile(sessionId, stream);
  }

  /** A dialog answer is not taken here: it goes the local pane's answer path. */
  async function remoteBrowserControl(
    sessionId: string,
    control: RemoteControl
  ): Promise<DesktopBrowserTabControlResult | void> {
    if (control.type === 'viewport') return applyViewport(sessionId, control);
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

  return { remoteBrowserStream, remoteBrowserControl, releaseViewer };
}
