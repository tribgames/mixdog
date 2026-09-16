/** Display sampling is read-only. It must never enter the CDP execution fence
 * or activate a hidden page window. At most one native capture may be pending
 * per page, including after a caller stops waiting. */
import type { WebContents } from 'electron';
import { browserScreenshotBytesFitBudget } from './screenshot-policy';
import type { BrowserScreenshotCapture } from './screenshot';
import { createBrowserDisplayStream } from './display-stream';
import { encodeBrowserDisplayPng } from './display-png';

export function createBrowserDisplayCapture(sharedTextures = false) {
  const pending = new WeakMap<WebContents, { documentId: string; work: Promise<BrowserScreenshotCapture> }>();
  const png = (bytes: Buffer): BrowserScreenshotCapture => {
    if (!browserScreenshotBytesFitBudget(bytes.length)) throw new Error('Browser display frame is too large.');
    return {
      data: bytes.toString('base64'),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      mimeType: 'image/png',
      fullPage: false,
    };
  };
  const encode = async (image: Electron.NativeImage) => png(await encodeBrowserDisplayPng(image));
  const stream = createBrowserDisplayStream(encode);
  return function capture(
    guest: WebContents,
    documentId = '',
    viewport?: { width: number; height: number }
  ): Promise<BrowserScreenshotCapture> {
    const key = `${documentId}:${viewport?.width ?? ''}:${viewport?.height ?? ''}`;
    const existing = pending.get(guest);
    if (existing) {
      if (existing.documentId === key) return existing.work;
      // Wait out the old native request, but never label its pixels as the
      // document that navigated while that request was outstanding.
      return existing.work.catch(() => undefined).then(() => capture(guest, documentId, viewport));
    }
    // Popups with native (non-offscreen) views do not emit paint events.
    // They retain the single-flight native path, not a silent stream fallback.
    const work =
      guest.isOffscreen?.() && !sharedTextures
        ? stream(guest, key, viewport)
        : guest.capturePage(undefined, { stayHidden: true }).then((image) => {
            const size = image.getSize();
            if (viewport && (size.width !== viewport.width || size.height !== viewport.height)) {
              throw new Error('Browser page changed during capture.');
            }
            return encode(image);
          });
    const entry = { documentId: key, work };
    pending.set(guest, entry);
    void work
      .finally(() => {
        if (pending.get(guest) === entry) pending.delete(guest);
      })
      .catch(() => {});
    return work;
  };
}
