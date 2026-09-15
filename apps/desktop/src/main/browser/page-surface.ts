/** Local, user-initiated controls address a document, not a sampled image.
 * Agent and remote controls retain their own stricter observation contracts. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl, DesktopBrowserPageFrame, DesktopBrowserTab } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { createBrowserInputDriver } from './input';
import { normalizePageUrl, type BrowserUrlPolicy } from './url-policy';
import type { BrowserScreenshotCapture } from './screenshot';
import type { BrowserDisplayTexture } from './display-textures';
import { browserInputRecovery } from '../../shared/browser-input-policy';
import type { createBrowserInputDispatch } from './input-dispatch';
import type { createBrowserLocalPrompts } from './local-prompts';

export function createBrowserPageSurface(host: {
  ensureGuest(sessionId: string, options: { reveal: false }): Promise<WebContents>;
  state: BrowserGuestStateStore;
  cdp: BrowserGuestCdp;
  dispatchInput?: ReturnType<typeof createBrowserInputDispatch>;
  prompts?: ReturnType<typeof createBrowserLocalPrompts>;
  urlPolicy: BrowserUrlPolicy;
  assertUrl(url: string, pageGenerated: boolean): Promise<void>;
  resize(guest: WebContents, width: number, height: number): void;
  viewport(guest: WebContents): { width: number; height: number; zoom: number };
  capture(guest: WebContents, geometryKey: string, viewport: { width: number; height: number }, signal?: AbortSignal): Promise<BrowserScreenshotCapture>;
  captureTexture?(guest: WebContents, documentId: string, viewport: { width: number; height: number }): BrowserDisplayTexture | undefined;
  currentGuest?(sessionId: string): WebContents | null;
  tabs?: {
    list(sessionId: string): DesktopBrowserTab[];
    select(sessionId: string, tabId: string): void;
    create(sessionId: string): void;
    close(sessionId: string, tabId: string): void;
  };
}) {
  const images = new WeakMap<WebContents, { shot: BrowserScreenshotCapture; id: string; documentId: string; geometryKey: string }>();
  const geometryRevisions = new WeakMap<WebContents, number>();
  const viewportChanges = new WeakMap<WebContents, number>();
  const invalidateGeometry = (guest: WebContents) => {
    geometryRevisions.set(guest, (geometryRevisions.get(guest) ?? 0) + 1);
    images.delete(guest);
  };
  const paneSizes = new Map<string, { width: number; height: number }>();
  const presentedGuests = new Map<string, WebContents>();
  const lastFrames = new WeakMap<WebContents, { frame: DesktopBrowserPageFrame; zoom: number }>();
  const lastTextureFrames = new WeakMap<WebContents, { frame: DesktopBrowserPageFrame; zoom: number }>();
  // Chromium's compositor occasionally rejects one display sample (it reports
  // "UnknownVizError" while a large capture is in flight). That single miss
  // keeps the last good frame on screen; only a capture that stays broken past
  // STALE_FRAME_MS reaches the client as a failure.
  const STALE_FRAME_MS = 3000;
  const captureFaults = new WeakMap<WebContents, number>();
  const documentId = (guest: WebContents) => browserDocumentId(host.state, guest);
  /** Pixels and input belong to one client only while this session still shows
   *  this document on this page; anything else is a frame from the past. */
  const presenting = (sessionId: string, guest: WebContents, token: string): boolean =>
    !guest.isDestroyed() && token === documentId(guest)
    && (!host.currentGuest || host.currentGuest(sessionId) === guest);
  const assertPresenting = (
    sessionId: string, guest: WebContents, token: string, signal?: AbortSignal,
  ): void => {
    signal?.throwIfAborted();
    if (!presenting(sessionId, guest, token)) throw new Error('Browser page changed during capture.');
  };
  /** A GPU frame crosses to the client through the compositor, so the document
   *  it belongs to is revalidated once that transfer lands. */
  const sendTexture = async (
    texture: BrowserDisplayTexture,
    sessionId: string,
    guest: WebContents,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    await texture.send(sessionId);
    assertPresenting(sessionId, guest, token, signal);
  };

  async function sample(
    guest: WebContents, geometryKey: string, viewport: { width: number; height: number }, signal?: AbortSignal,
  ): Promise<BrowserScreenshotCapture> {
    try {
      const shot = await host.capture(guest, geometryKey, viewport, signal);
      captureFaults.delete(guest);
      return shot;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (String((error as Error)?.message || error) === 'Browser page changed during capture.') throw error;
      const cached = images.get(guest);
      const since = captureFaults.get(guest) ?? Date.now();
      captureFaults.set(guest, since);
      if (!cached || cached.geometryKey !== geometryKey || Date.now() - since > STALE_FRAME_MS) throw error;
      return cached.shot;
    }
  }

  async function frame(sessionId: string, previousId = '', signal?: AbortSignal, useTexture = false): Promise<DesktopBrowserPageFrame> {
    const previousFrames = useTexture ? lastTextureFrames : lastFrames;
    const guest = await host.ensureGuest(sessionId, { reveal: false });
    signal?.throwIfAborted();
    if (presentedGuests.get(sessionId) !== guest) {
      // Newly selected popup renderers can start with a zero-sized viewport.
      // Give them the pane's geometry before asking for their first pixels;
      // the renderer cannot report a resize until that first frame arrives.
      const size = paneSizes.get(sessionId);
      if (size) host.resize(guest, size.width, size.height);
      presentedGuests.set(sessionId, guest);
    }
    if (host.state.for(guest).pendingDialog) {
      // A synchronous dialog also blocks layout metrics. Present its controls
      // entirely from native state; never wait for the page it is blocking.
      const viewport = host.viewport(guest);
      const token = documentId(guest);
      const previous = previousFrames.get(guest);
      const cached = previous?.frame.documentId === token && previous.zoom === viewport.zoom
        && previous.frame.surfaceWidth === viewport.width && previous.frame.surfaceHeight === viewport.height
        ? previous.frame : undefined;
      const texture = useTexture ? host.captureTexture?.(guest, token, viewport) : undefined;
      try {
      if (texture) await sendTexture(texture, sessionId, guest, token, signal);
      return {
        frameId: texture?.id ?? cached?.frameId ?? `blocked_${token}_${viewport.width}_${viewport.height}_${viewport.zoom}`,
        documentId: token, webContentsId: guest.id,
        url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoadingMainFrame(),
        canGoBack: guest.navigationHistory.canGoBack(), canGoForward: guest.navigationHistory.canGoForward(),
        width: cached?.width ?? viewport.width, height: cached?.height ?? viewport.height,
        viewportWidth: cached?.viewportWidth ?? viewport.width,
        viewportHeight: cached?.viewportHeight ?? viewport.height,
        surfaceWidth: viewport.width, surfaceHeight: viewport.height,
        ...(cached && cached.frameId !== previousId && !texture ? { image: cached.image } : {}),
        ...(texture ? { textureId: texture.id } : {}),
        ...(host.tabs ? { tabs: host.tabs.list(sessionId) } : {}),
        ...host.prompts?.describe(guest),
      };
      } finally { texture?.release(); }
    }
    const debuggerInstance = await host.cdp.guestDebugger(guest);
    if (viewportChanges.get(guest)) throw new Error('Browser page changed during capture.');
    const token = documentId(guest);
    const nativeViewport = host.viewport(guest);
    const revision = geometryRevisions.get(guest) ?? 0;
    const geometryKey = `${token}:${revision}:${nativeViewport.width}:${nativeViewport.height}:${nativeViewport.zoom}:${useTexture}`;
    // Display metadata is a native read, not a page script. In particular, a
    // display timeout must never terminate an unrelated agent evaluation or
    // leave subsequent human input behind its execution cleanup fence.
    const texture = useTexture ? host.captureTexture?.(guest, token, nativeViewport) : undefined;
    try {
    const [shot, metrics] = await Promise.all([
      texture
        ? Promise.resolve<BrowserScreenshotCapture>({
          width: texture.width, height: texture.height, data: '', mimeType: 'image/png', fullPage: false,
        })
        : sample(guest, geometryKey, nativeViewport, signal),
      host.cdp.bounded(
        debuggerInstance.sendCommand('Page.getLayoutMetrics').catch(error => {
          // A popup's first navigation can replace the renderer target while
          // native metadata is in flight. Discard it like any other old frame.
          if (!guest.isDestroyed() && String(error?.message || error) === 'target closed while handling command') {
            throw new Error('Browser page changed during capture.');
          }
          throw error;
        }) as Promise<{
          cssVisualViewport: { scale: number };
        }>,
        2_000, 'Browser display viewport', signal,
      ),
    ]);
    assertPresenting(sessionId, guest, token);
    const pageScale = metrics.cssVisualViewport?.scale;
    if (!(pageScale > 0 && nativeViewport.zoom > 0)) {
      throw new Error('Browser display viewport is not ready.');
    }
    // CDP clientWidth excludes desktop scrollbars, while the displayed image
    // and input coordinates include them. Native bounds plus page/zoom scale
    // preserve window.innerWidth/innerHeight without executing page script.
    const scale = pageScale * nativeViewport.zoom;
    const viewport = {
      width: Math.ceil(nativeViewport.width / scale - 0.001),
      height: Math.ceil(nativeViewport.height / scale - 0.001),
    };
    const latestViewport = host.viewport(guest);
    if (latestViewport.width !== nativeViewport.width || latestViewport.height !== nativeViewport.height
      || latestViewport.zoom !== nativeViewport.zoom || viewportChanges.get(guest)
      || (geometryRevisions.get(guest) ?? 0) !== revision) {
      throw new Error('Browser page changed during capture.');
    }
    assertPresenting(sessionId, guest, token, signal);
    let image = images.get(guest);
    if (!image || image.geometryKey !== geometryKey || image.shot.data !== shot.data
      || (texture && image.id !== texture.id)) {
      image = { shot, documentId: token, geometryKey,
        id: texture?.id ?? `local_${guest.id}_${Date.now()}_${Math.random().toString(36).slice(2)}` };
      images.set(guest, image);
    }
    const result: DesktopBrowserPageFrame = {
      frameId: image.id, documentId: token, webContentsId: guest.id,
      viewportWidth: viewport.width, viewportHeight: viewport.height,
      surfaceWidth: nativeViewport.width, surfaceHeight: nativeViewport.height,
      url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoadingMainFrame(),
      canGoBack: guest.navigationHistory.canGoBack(), canGoForward: guest.navigationHistory.canGoForward(),
      width: shot.width, height: shot.height, fault: host.state.for(guest).fault || undefined,
      ...(texture ? { textureId: texture.id } : {}),
      ...(host.tabs ? { tabs: host.tabs.list(sessionId) } : {}),
      ...host.prompts?.describe(guest),
      ...(previousId === image.id || !shot.data ? {} : { image: { mimeType: shot.mimeType, data: shot.data } }),
    };
    if (texture) await sendTexture(texture, sessionId, guest, token, signal);
    previousFrames.set(guest, {
      frame: { ...result, ...(texture ? {} : { image: { mimeType: shot.mimeType, data: shot.data } }) }, zoom: nativeViewport.zoom,
    });
    return result;
    } finally { texture?.release(); }
  }

  async function control(sessionId: string, input: DesktopBrowserPageControl, signal?: AbortSignal): Promise<void> {
    // Tab chrome targets a session-owned page, not the document inside it.
    // Navigation and a blocked page dialog must not trap the user on that tab.
    signal?.throwIfAborted();
    if (input.type === 'new-tab' || input.type === 'select-tab' || input.type === 'close-tab') {
      if (!host.tabs) throw new Error('Browser tabs are unavailable.');
      if (input.type === 'new-tab') host.tabs.create(sessionId);
      else if (input.type === 'select-tab') host.tabs.select(sessionId, input.tabId);
      else host.tabs.close(sessionId, input.tabId);
      return;
    }
    const guest = await host.ensureGuest(sessionId, { reveal: false });
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (!presenting(sessionId, guest, input.documentId)) {
        throw new Error('Browser page changed; input was not sent.');
      }
    };
    assertCurrent();
    if (input.type === 'answer-dialog' || input.type === 'choose-files') {
      if (!host.prompts) throw new Error('Browser prompt controls are unavailable.');
      await host.prompts.answer(guest, input, assertCurrent, signal);
      host.state.invalidateInteraction(guest);
      return;
    }
    if (input.type === 'resize') {
      const size = { width: Math.round(input.width), height: Math.round(input.height) };
      paneSizes.set(sessionId, size);
      invalidateGeometry(guest);
      host.resize(guest, size.width, size.height);
      return;
    }
    // Native recovery releases a blocked execution; it must not wait for that
    // execution or be rejected by the dialog it is intended to escape.
    if (browserInputRecovery(input)) {
      host.state.invalidateInteraction(guest);
      if (input.type === 'reload') guest.reload();
      else guest.stop();
      return;
    }
    await host.cdp.waitForIdle(guest, signal);
    assertCurrent();
    if (host.state.for(guest).pendingDialog) throw new Error('Browser dialog is blocking input.');
    host.state.invalidateInteraction(guest);
    const assertDispatch = () => {
      assertCurrent();
      if (host.state.for(guest).pendingDialog) throw new Error('Browser dialog is blocking input.');
    };
    const send = async (target: WebContents, method: string, params: Record<string, unknown>, inputSignal?: AbortSignal) => {
      if (host.dispatchInput) return host.dispatchInput(target, method, params, inputSignal, assertDispatch);
      const debuggerInstance = await host.cdp.guestDebugger(target);
      assertDispatch();
      // The CDP transport may itself wait for cleanup after initialization.
      // Revalidate in that transport, with no await before the actual send.
      return host.cdp.sendCdpInput(target, debuggerInstance, method, params, inputSignal, undefined, assertDispatch);
    };
    // Each key sequence retains its own document guard across every dispatch.
    const keyboard = createBrowserInputDriver(send, { allowClipboard: true });
    switch (input.type) {
      case 'navigate': {
        const url = normalizePageUrl(input.url, host.urlPolicy);
        await host.assertUrl(url, true);
        assertCurrent();
        void guest.loadURL(url).catch(() => {});
        break;
      }
      case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); break;
      case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); break;
      case 'zoom': invalidateGeometry(guest); guest.setZoomFactor(input.factor); break;
      case 'text': await send(guest, 'Input.insertText', { text: input.text }, signal); break;
      case 'composition': await send(guest, 'Input.imeSetComposition', {
        text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
      }, signal); break;
      case 'composition-end':
        await send(guest, input.text ? 'Input.insertText' : 'Input.imeSetComposition',
          input.text ? { text: input.text } : { text: '', selectionStart: 0, selectionEnd: 0 }, signal);
        break;
      case 'key': await keyboard.pressKey(guest, input.key, signal); break;
      case 'pointer': await send(guest, 'Input.dispatchMouseEvent', {
        type: input.phase, x: input.x, y: input.y, button: input.button,
        buttons: input.buttons, modifiers: input.modifiers, clickCount: input.clickCount,
      }, signal); break;
      case 'wheel': await send(guest, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: input.x, y: input.y,
        deltaX: input.deltaX, deltaY: input.deltaY,
      }, signal); break;
    }
  }

  return {
    frame, control,
    beginViewportChange(guest: WebContents): () => void {
      viewportChanges.set(guest, (viewportChanges.get(guest) ?? 0) + 1);
      invalidateGeometry(guest);
      return () => {
        const remaining = (viewportChanges.get(guest) ?? 1) - 1;
        if (remaining) viewportChanges.set(guest, remaining);
        else viewportChanges.delete(guest);
        invalidateGeometry(guest);
      };
    },
    release(sessionId: string) {
      paneSizes.delete(sessionId);
      presentedGuests.delete(sessionId);
    },
  };
}
