/** Element screenshots: one viewport (or document) capture, cropped to the
 *  element the caller named. */
import { nativeImage, type Rectangle, type WebContents } from 'electron';

import { screenshotClipForElement } from './screenshot-clip';
import { BrowserScreenshotRestoreError, encodeImage } from './screenshot-engines';
import type { EncodedBrowserScreenshot, ScreenshotCropInput } from './screenshot-image';
import { normalizeScreenshotOptions } from './screenshot-policy';

export type ScreenshotEncoding = { format?: unknown; quality?: unknown };

/** The service's raw (untimed) page capture, which element capture composes. */
export type ScreenshotCapture = (
  guest: WebContents,
  background: boolean,
  rawOptions: ScreenshotEncoding & { fullPage?: unknown },
  signal?: AbortSignal
) => Promise<ScreenshotCropInput>;

interface ElementPageGeometry {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

export function createElementCapture(capture: ScreenshotCapture) {
  return async function captureElement(
    guest: WebContents,
    background: boolean,
    rawOptions: ScreenshotEncoding,
    element: Rectangle,
    page: ElementPageGeometry,
    signal?: AbortSignal
  ): Promise<EncodedBrowserScreenshot & { partial: boolean }> {
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
    // Native and stitched images still crop the encoded source: cropping the
    // original pixels would skip the first JPEG encoding and change the crop.
    const source = shot.cropSource ?? nativeImage.createFromBuffer(shot.bytes);
    const cropped = encodeImage(source.crop(rect), options);
    if (!cropped) throw new Error('the element screenshot exceeded the image limits');
    return { ...cropped, partial };
  };
}

async function captureWithinDocument(
  capture: ScreenshotCapture,
  guest: WebContents,
  background: boolean,
  rawOptions: ScreenshotEncoding,
  element: Rectangle,
  scroll: { x: number; y: number },
  signal?: AbortSignal
): Promise<{ shot: ScreenshotCropInput; documentRect: Rectangle } | null> {
  let shot: ScreenshotCropInput;
  try {
    shot = await capture(guest, background, { ...rawOptions, fullPage: true }, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    // A page left scrolled or re-laid out is not a missing image: it is reported.
    if (error instanceof BrowserScreenshotRestoreError) throw error;
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
