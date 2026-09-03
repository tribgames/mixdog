/**
 * The remote (mobile) view of a session's visible page: a de-duplicated JPEG
 * frame the client polls for, and the gestures it sends back. Gestures are
 * bound to the frame they were made on so a stale screen never drives the
 * wrong page.
 */
import type { WebContents } from 'electron';

import type {
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserFrame,
} from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import type { BrowserGuestStateStore } from './guest-state';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';
import { browserImagePointToCss, type createBrowserInputDriver } from './input';
import type { BrowserScreenshotCapture } from './screenshot';

export interface BrowserRemoteControlHost {
  state: BrowserGuestStateStore;
  cdp: Pick<BrowserGuestCdp, 'guestDebugger' | 'sendCdpInput' | 'waitForInitialDocument'>;
  input: ReturnType<typeof createBrowserInputDriver>;
  urlPolicy: BrowserUrlPolicy;
  ensureGuest(sessionId: string, options?: { reveal?: boolean }): Promise<WebContents>;
  /** A phone is viewing this session now; the desktop keeps its guest where
   *  Chromium still composes frames for it. */
  noteRemoteViewer?(sessionId: string): void;
  captureScreenshot(
    guest: WebContents,
    background: boolean,
    options: { format?: unknown; quality?: unknown },
  ): Promise<BrowserScreenshotCapture>;
  assertResolvedUrlAllowed(url: string, pageGenerated: boolean): Promise<void>;
}

export function createBrowserRemoteControl(host: BrowserRemoteControlHost) {
  const {
    state,
    cdp,
    input,
    urlPolicy,
    ensureGuest,
    noteRemoteViewer,
    captureScreenshot,
    assertResolvedUrlAllowed,
  } = host;

  async function remoteBrowserFrame(
    sessionId: string,
    previousFrameId = '',
  ): Promise<DesktopRemoteBrowserFrame> {
    noteRemoteViewer?.(sessionId);
    const guest = await ensureGuest(sessionId, { reveal: false });
    await cdp.waitForInitialDocument(guest);
    const capture = await captureScreenshot(guest, false, {
      format: 'jpeg',
      quality: 58,
    });
    const record = state.for(guest);
    const previous = record.remoteFrame;
    const url = guest.getURL() || 'about:blank';
    const current = previous
      && previous.image.data === capture.data
      && previous.width === capture.width
      && previous.height === capture.height
      && previous.url === url
      ? previous
      : {
        frameId: `rbf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        image: { mimeType: capture.mimeType, data: capture.data },
        width: capture.width,
        height: capture.height,
        url,
      };
    if (current !== previous) record.remoteFrame = current;
    const history = guest.navigationHistory;
    return {
      frameId: current.frameId,
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

  async function remoteBrowserControl(
    sessionId: string,
    control: DesktopRemoteBrowserControl,
  ): Promise<void> {
    noteRemoteViewer?.(sessionId);
    const guest = await ensureGuest(sessionId, { reveal: false });
    if (['tap', 'swipe', 'scroll', 'text', 'key'].includes(control.type)) {
      const frame = state.peek(guest)?.remoteFrame;
      if (!frame || !('frameId' in control) || control.frameId !== frame.frameId) {
        throw new Error('Remote Browser Use frame is stale; wait for the latest frame and retry.');
      }
    }
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
          browserImagePointToCss(control.to, guest.getZoomFactor()),
        );
        return;
      case 'scroll': {
        const zoom = guest.getZoomFactor() || 1;
        const point = browserImagePointToCss(control, zoom);
        await input.scrollAt(guest, point, control.deltaX / zoom, control.deltaY / zoom);
        return;
      }
      case 'text':
        await cdp.sendCdpInput(
          guest,
          await cdp.guestDebugger(guest),
          'Input.insertText',
          { text: control.text },
        );
        return;
      case 'key':
        await input.pressKey(guest, control.key);
    }
  }

  return { remoteBrowserFrame, remoteBrowserControl };
}
