/** Element screenshots: one viewport (or document) capture, cropped to the
 *  element the caller named. */
import type { Rectangle, WebContents } from 'electron';
import { nativeImage } from 'electron';

import { screenshotClipForElement } from './screenshot-clip';
import { encodeImage, type BrowserScreenshotCapture } from './screenshot-engines';
import { normalizeScreenshotOptions } from './screenshot-policy';

export type ScreenshotEncoding = { format?: unknown; quality?: unknown };

/** The service's raw (untimed) page capture, which element capture composes. */
export type ScreenshotCapture = (
  guest: WebContents,
  background: boolean,
  rawOptions: ScreenshotEncoding & { fullPage?: unknown },
  signal?: AbortSignal
) => Promise<BrowserScreenshotCapture>;

export interface ElementPageGeometry {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

export function createElementCapture(capture: ScreenshotCapture) {
  /** The element the caller named, as an image of its own. It is cropped out
   *  of one viewport capture, and the page measurement and the image come
   *  from the same settled viewport, so the crop holds on a zoomed or
   *  high-DPI display. An element that does not fit the window is painted
   *  past it instead of being cut short. */
  return async function captureElement(
    guest: WebContents,
    background: boolean,
    rawOptions: ScreenshotEncoding,
    element: Rectangle,
    page: ElementPageGeometry,
    signal?: AbortSignal
  ): Promise<BrowserScreenshotCapture & { partial: boolean }> {
    const options = normalizeScreenshotOptions({ format: rawOptions.format, quality: rawOptions.quality });
    // The capture is asked in the caller's own terms: normalized options carry
    // a default quality, which a PNG request is not allowed to name.
    const encoding = { format: rawOptions.format, quality: rawOptions.quality };
    const oversized = element.width > page.viewport.width || element.height > page.viewport.height;
    const documentCapture = oversized
      ? await captureWithinDocument(capture, guest, background, encoding, element, page.scroll, signal)
      : null;
    const shot = documentCapture?.shot || (await capture(guest, background, encoding, signal));
    const { rect, partial } = screenshotClipForElement(
      documentCapture?.documentRect || element,
      documentCapture?.shot.pageRect || page.viewport,
      shot
    );
    const cropped = encodeImage(nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).crop(rect), options);
    if (!cropped) throw new Error('the element screenshot exceeded the image limits');
    return { ...cropped, partial };
  };
}

/** An element taller or wider than the window is cut out of the document
 *  capture instead, which is the only capture that holds all of it. A page
 *  too large to capture whole leaves the viewport crop as the honest
 *  partial answer. */
async function captureWithinDocument(
  capture: ScreenshotCapture,
  guest: WebContents,
  background: boolean,
  rawOptions: ScreenshotEncoding,
  element: Rectangle,
  scroll: { x: number; y: number },
  signal?: AbortSignal
): Promise<{ shot: BrowserScreenshotCapture; documentRect: Rectangle } | null> {
  let shot: BrowserScreenshotCapture;
  try {
    shot = await capture(guest, background, { ...rawOptions, fullPage: true }, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    return null;
  }
  // The capture reports the document box it clipped, so the element lands in
  // the image without re-measuring the page a second time.
  if (!shot.pageRect) return null;
  return {
    shot,
    documentRect: {
      x: element.x + scroll.x - shot.pageRect.x,
      y: element.y + scroll.y - shot.pageRect.y,
      width: element.width,
      height: element.height,
    },
  };
}
