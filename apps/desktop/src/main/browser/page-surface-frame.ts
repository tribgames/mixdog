/** One display frame of a page for the local client: either the native-state
 *  frame a blocking dialog allows, or a sampled image whose geometry is
 *  revalidated after the capture, with a short tolerance for compositor misses. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageFrame } from '../../shared/contract';
import type { BrowserScreenshotCapture } from './screenshot';
import type { BrowserDisplayTexture } from './display-textures';
import type { BrowserPageSurfaceHost } from './page-surface';
import type { PageSurfaceState } from './page-surface-state';

// Chromium's compositor occasionally rejects one display sample (it reports
// "UnknownVizError" while a large capture is in flight). That single miss
// keeps the last good frame on screen; only a capture that stays broken past
// STALE_FRAME_MS reaches the client as a failure.
const STALE_FRAME_MS = 3000;

type FrameMemory = WeakMap<WebContents, { frame: DesktopBrowserPageFrame; zoom: number }>;

export function createPageSurfaceFrame(host: BrowserPageSurfaceHost, state: PageSurfaceState) {
  const { images, geometryRevisions, viewportChanges, paneSizes, presentedGuests, documentId, presenting } = state;
  const lastFrames: FrameMemory = new WeakMap();
  const lastTextureFrames: FrameMemory = new WeakMap();
  const captureFaults = new WeakMap<WebContents, number>();

  const assertPresenting = (sessionId: string, guest: WebContents, token: string, signal?: AbortSignal): void => {
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
    signal?: AbortSignal
  ): Promise<void> => {
    await texture.send(sessionId);
    assertPresenting(sessionId, guest, token, signal);
  };

  async function sample(
    guest: WebContents,
    geometryKey: string,
    viewport: { width: number; height: number },
    signal?: AbortSignal
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

  /** A synchronous dialog also blocks layout metrics. Present its controls
   *  entirely from native state; never wait for the page it is blocking. */
  async function blockedDialogFrame(
    sessionId: string,
    guest: WebContents,
    previousId: string,
    previousFrames: FrameMemory,
    useTexture: boolean,
    signal?: AbortSignal
  ): Promise<DesktopBrowserPageFrame> {
    const viewport = host.viewport(guest);
    const token = documentId(guest);
    const previous = previousFrames.get(guest);
    const cached =
      previous?.frame.documentId === token &&
      previous.zoom === viewport.zoom &&
      previous.frame.surfaceWidth === viewport.width &&
      previous.frame.surfaceHeight === viewport.height
        ? previous.frame
        : undefined;
    const texture = useTexture ? host.captureTexture?.(guest, token, viewport) : undefined;
    try {
      if (texture) await sendTexture(texture, sessionId, guest, token, signal);
      return {
        frameId:
          texture?.id ?? cached?.frameId ?? `blocked_${token}_${viewport.width}_${viewport.height}_${viewport.zoom}`,
        documentId: token,
        webContentsId: guest.id,
        url: guest.getURL(),
        title: guest.getTitle(),
        loading: guest.isLoadingMainFrame(),
        canGoBack: guest.navigationHistory.canGoBack(),
        canGoForward: guest.navigationHistory.canGoForward(),
        width: cached?.width ?? viewport.width,
        height: cached?.height ?? viewport.height,
        viewportWidth: cached?.viewportWidth ?? viewport.width,
        viewportHeight: cached?.viewportHeight ?? viewport.height,
        surfaceWidth: viewport.width,
        surfaceHeight: viewport.height,
        ...(cached && cached.frameId !== previousId && !texture ? { image: cached.image } : {}),
        ...(texture ? { textureId: texture.id } : {}),
        ...(host.tabs ? { tabs: host.tabs.list(sessionId) } : {}),
        ...host.prompts?.describe(guest),
      };
    } finally {
      texture?.release();
    }
  }

  /** Display metadata is a native read, not a page script. In particular, a
   *  display timeout must never terminate an unrelated agent evaluation or
   *  leave subsequent human input behind its execution cleanup fence. */
  async function layoutMetrics(guest: WebContents, debuggerInstance: Electron.Debugger, signal?: AbortSignal) {
    return host.cdp.bounded(
      debuggerInstance.sendCommand('Page.getLayoutMetrics').catch((error) => {
        // A popup's first navigation can replace the renderer target while
        // native metadata is in flight. Discard it like any other old frame.
        if (!guest.isDestroyed() && String(error?.message || error) === 'target closed while handling command') {
          throw new Error('Browser page changed during capture.');
        }
        throw error;
      }) as Promise<{
        cssVisualViewport: { scale: number };
      }>,
      2_000,
      'Browser display viewport',
      signal
    );
  }

  async function liveFrame(
    sessionId: string,
    guest: WebContents,
    previousId: string,
    previousFrames: FrameMemory,
    useTexture: boolean,
    signal?: AbortSignal
  ): Promise<DesktopBrowserPageFrame> {
    const debuggerInstance = await host.cdp.guestDebugger(guest);
    if (viewportChanges.get(guest)) throw new Error('Browser page changed during capture.');
    const token = documentId(guest);
    const nativeViewport = host.viewport(guest);
    const revision = geometryRevisions.get(guest) ?? 0;
    const geometryKey = `${token}:${revision}:${nativeViewport.width}:${nativeViewport.height}:${nativeViewport.zoom}:${useTexture}`;
    const texture = useTexture ? host.captureTexture?.(guest, token, nativeViewport) : undefined;
    try {
      const [shot, metrics] = await Promise.all([
        texture
          ? Promise.resolve<BrowserScreenshotCapture>({
              width: texture.width,
              height: texture.height,
              data: '',
              mimeType: 'image/png',
              fullPage: false,
            })
          : sample(guest, geometryKey, nativeViewport, signal),
        layoutMetrics(guest, debuggerInstance, signal),
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
      if (
        latestViewport.width !== nativeViewport.width ||
        latestViewport.height !== nativeViewport.height ||
        latestViewport.zoom !== nativeViewport.zoom ||
        viewportChanges.get(guest) ||
        (geometryRevisions.get(guest) ?? 0) !== revision
      ) {
        throw new Error('Browser page changed during capture.');
      }
      assertPresenting(sessionId, guest, token, signal);
      let image = images.get(guest);
      if (
        !image ||
        image.geometryKey !== geometryKey ||
        image.shot.data !== shot.data ||
        (texture && image.id !== texture.id)
      ) {
        image = {
          shot,
          documentId: token,
          geometryKey,
          id: texture?.id ?? `local_${guest.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        };
        images.set(guest, image);
      }
      const result: DesktopBrowserPageFrame = {
        frameId: image.id,
        documentId: token,
        webContentsId: guest.id,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        surfaceWidth: nativeViewport.width,
        surfaceHeight: nativeViewport.height,
        url: guest.getURL(),
        title: guest.getTitle(),
        loading: guest.isLoadingMainFrame(),
        canGoBack: guest.navigationHistory.canGoBack(),
        canGoForward: guest.navigationHistory.canGoForward(),
        width: shot.width,
        height: shot.height,
        fault: host.state.for(guest).fault || undefined,
        ...(texture ? { textureId: texture.id } : {}),
        ...(host.tabs ? { tabs: host.tabs.list(sessionId) } : {}),
        ...host.prompts?.describe(guest),
        ...(previousId === image.id || !shot.data ? {} : { image: { mimeType: shot.mimeType, data: shot.data } }),
      };
      if (texture) await sendTexture(texture, sessionId, guest, token, signal);
      previousFrames.set(guest, {
        frame: { ...result, ...(texture ? {} : { image: { mimeType: shot.mimeType, data: shot.data } }) },
        zoom: nativeViewport.zoom,
      });
      return result;
    } finally {
      texture?.release();
    }
  }

  return async function frame(
    sessionId: string,
    previousId = '',
    signal?: AbortSignal,
    useTexture = false
  ): Promise<DesktopBrowserPageFrame> {
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
      return blockedDialogFrame(sessionId, guest, previousId, previousFrames, useTexture, signal);
    }
    return liveFrame(sessionId, guest, previousId, previousFrames, useTexture, signal);
  };
}
