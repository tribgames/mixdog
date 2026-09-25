/**
 * The remote (mobile) view of a session's visible page: a de-duplicated JPEG
 * frame the client polls for, and the gestures it sends back. Pointer input
 * is frame-bound; keyboard input is document-bound so normal typing does
 * not depend on a new screenshot arriving between characters.
 */
import type { WebContents } from 'electron';

import type { DesktopRemoteBrowserControl, DesktopRemoteBrowserFrame } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';
import { browserImagePointToCss, type createBrowserInputDriver } from './input';
import type { BrowserScreenshotCapture } from './screenshot';
import { sendRemoteBrowserKeyboard } from './remote-keyboard';

export interface BrowserRemoteControlHost {
  state: BrowserGuestStateStore;
  cdp: Pick<BrowserGuestCdp, 'guestDebugger' | 'sendCdpInput' | 'waitForInitialDocument'>;
  input: ReturnType<typeof createBrowserInputDriver>;
  urlPolicy: BrowserUrlPolicy;
  ensureGuest(sessionId: string, options?: { reveal?: boolean }): Promise<WebContents>;
  /** A phone started or stopped viewing this session; the display client keeps
   *  a watched guest where Chromium still composes frames for it. */
  viewerChanged?(sessionId: string, active: boolean): void;
  onUserControl?(guest: WebContents): void;
  captureScreenshot(
    guest: WebContents,
    background: boolean,
    options: { format?: unknown; quality?: unknown }
  ): Promise<BrowserScreenshotCapture>;
  assertResolvedUrlAllowed(url: string, pageGenerated: boolean): Promise<void>;
  revision?(guest: WebContents): Promise<string>;
}

export function createBrowserRemoteControl(host: BrowserRemoteControlHost) {
  const { state, cdp, input, urlPolicy, ensureGuest, captureScreenshot, assertResolvedUrlAllowed } = host;

  // A phone polls frames every 350–900ms while its Browser Use sheet is open.
  // The desktop parks an unshown guest OFF-window, where Chromium composes no
  // frames and every capture for it would time out. While a phone is viewing,
  // the display client keeps that guest inside the window under the UI;
  // presence drops after the polling stops.
  const REMOTE_VIEWER_IDLE_MS = 4_000;
  /** One encoding for the frame and its pre-gesture recheck, so their pixels compare. */
  const REMOTE_FRAME_CAPTURE = { format: 'jpeg', quality: 58 } as const;
  const viewerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function noteViewer(sessionId: string): void {
    const previous = viewerTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    else host.viewerChanged?.(sessionId, true);
    const idle = setTimeout(() => {
      viewerTimers.delete(sessionId);
      host.viewerChanged?.(sessionId, false);
    }, REMOTE_VIEWER_IDLE_MS);
    // Presence is a display hint; it must never keep the process awake.
    idle.unref?.();
    viewerTimers.set(sessionId, idle);
  }

  /** The session is gone: nobody is viewing it, and nothing is left to report. */
  function releaseViewer(sessionId: string): void {
    const timer = viewerTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    viewerTimers.delete(sessionId);
  }

  async function remoteBrowserFrame(sessionId: string, previousFrameId = ''): Promise<DesktopRemoteBrowserFrame> {
    noteViewer(sessionId);
    const guest = await ensureGuest(sessionId, { reveal: false });
    await cdp.waitForInitialDocument(guest);
    const documentId = browserDocumentId(state, guest);
    const revision = await host.revision?.(guest);
    const capture = await captureScreenshot(guest, false, REMOTE_FRAME_CAPTURE);
    const record = state.for(guest);
    if (revision !== (await host.revision?.(guest)) || documentId !== browserDocumentId(state, guest)) {
      throw new Error('Remote Browser Use page changed during capture; wait for a fresh frame.');
    }
    const previous = record.remoteFrame;
    const url = guest.getURL() || 'about:blank';
    const current =
      previous &&
      previous.image.data === capture.data &&
      previous.width === capture.width &&
      previous.height === capture.height &&
      previous.url === url &&
      previous.revision === revision
        ? previous
        : {
            frameId: `rbf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            image: { mimeType: capture.mimeType, data: capture.data },
            width: capture.width,
            height: capture.height,
            url,
            capturedAt: Date.now(),
            revision,
          };
    current.capturedAt = Date.now();
    if (current !== previous) record.remoteFrame = current;
    const history = guest.navigationHistory;
    return {
      frameId: current.frameId,
      documentId,
      url,
      title: guest.getTitle(),
      loading: guest.isLoadingMainFrame(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      width: current.width,
      height: current.height,
      ...(previousFrameId === current.frameId ? {} : { image: current.image }),
    };
  }

  async function remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<void> {
    noteViewer(sessionId);
    const guest = await ensureGuest(sessionId, { reveal: false });
    host.onUserControl?.(guest);
    if ((control.type === 'text' || control.type === 'key') && control.documentId !== undefined) {
      await sendRemoteBrowserKeyboard({ state, cdp }, guest, control);
      return;
    }
    if (['tap', 'swipe', 'scroll', 'text', 'key'].includes(control.type)) {
      const frame = state.peek(guest)?.remoteFrame;
      if (!frame || !('frameId' in control) || control.frameId !== frame.frameId) {
        throw new Error('Remote Browser Use frame is stale; wait for the latest frame and retry.');
      }
      if (
        frame.url !== guest.getURL() ||
        !frame.capturedAt ||
        Date.now() - frame.capturedAt > 10_000 ||
        frame.revision !== (await host.revision?.(guest))
      ) {
        state.invalidateInteraction(guest);
        throw new Error('Remote Browser Use page changed; wait for the latest frame and retry.');
      }
      // DOM revisions do not cover canvas/video. Compare the actual pixels too.
      const current = await captureScreenshot(guest, false, REMOTE_FRAME_CAPTURE);
      if (current.data !== frame.image.data || state.peek(guest)?.remoteFrame !== frame) {
        state.invalidateInteraction(guest);
        throw new Error('Remote Browser Use image changed; wait for the latest frame and retry.');
      }
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
      case 'tap':
        await input.tapAt(guest, browserImagePointToCss(control, guest.getZoomFactor()));
        return;
      case 'swipe':
        await input.swipeAt(
          guest,
          browserImagePointToCss(control.from, guest.getZoomFactor()),
          browserImagePointToCss(control.to, guest.getZoomFactor())
        );
        return;
      case 'scroll': {
        const zoom = guest.getZoomFactor() || 1;
        const point = browserImagePointToCss(control, zoom);
        await input.scrollAt(guest, point, control.deltaX / zoom, control.deltaY / zoom);
        return;
      }
      case 'text':
        await cdp.sendCdpInput(guest, await cdp.guestDebugger(guest), 'Input.insertText', { text: control.text });
        return;
      case 'key':
        await input.pressKey(guest, control.key);
    }
  }

  return { remoteBrowserFrame, remoteBrowserControl, releaseViewer };
}
