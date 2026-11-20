/** Hidden/offscreen compositors only paint the current viewport, even when CDP
 * allocates a document-sized image. Stitch actual viewport pixels, preserving
 * layout, emulation, zoom and the original scroll position. */
import { nativeImage, type WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';
import { COMMAND_TIMEOUT_MS } from './host-types';
import { browserRenderCheckpoint } from './render-checkpoint';
import {
  bandCaptureArea,
  bandImageCrop,
  bandOutputRect,
  boundedFullPageRect,
  fullPageBandPlan,
  fullPageBandTimeoutMs,
  fullPageExceedsLimits,
  fullPageOutputSize,
  type BrowserScreenshotOptions,
  type BrowserScreenshotRect,
} from './screenshot-policy';
import { BrowserScreenshotRestoreError, captureViewportImage, encodeImage } from './screenshot-engines';
import type { EncodedBrowserScreenshot } from './screenshot-image';

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  /** The visual viewport: its document position, visible CSS size (without
   *  scrollbars) and pinch scale. */
  left: number;
  top: number;
  visibleWidth: number;
  visibleHeight: number;
  scale: number;
  /** Device px per CSS px, page zoom included. */
  dpr: number;
}

/** What the command leaves a banded capture: its ceiling, less the time it
 *  spends before the capture (settling, the privacy check, pinning the layout)
 *  and after it (putting the page back, encoding). */
const BANDED_CAPTURE_CEILING_MS = COMMAND_TIMEOUT_MS - 6_000;

export async function captureTiledDocument(
  cdp: BrowserCdpPort,
  guest: WebContents,
  rect: BrowserScreenshotRect,
  options: BrowserScreenshotOptions,
  timeoutMs: number,
  viewportTimeoutMs: number,
  signal?: AbortSignal,
  /** Deliver a page past the image limits scaled down instead of refusing it.
   *  Off for an element crop, which needs the document at its own resolution. */
  scaleToFit = true
): Promise<EncodedBrowserScreenshot> {
  const started = performance.now();
  let deadline = started + timeoutMs;
  const windowObject = await cdp.call<{ result?: { objectId?: string } }>(
    guest,
    'Runtime.evaluate',
    { expression: 'window', returnByValue: false },
    signal
  );
  const objectId = windowObject.result?.objectId;
  if (!objectId) throw new Error('full-page capture could not bind its document');
  const viewport = async (position: { x: number; y: number } | null, readSignal?: AbortSignal) => {
    const response = await cdp.call<{ result?: { value?: Viewport }; exceptionDetails?: unknown }>(
      guest,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `async function(position) {
          if (position) this.scrollTo({left:position.x,top:position.y,behavior:'instant'});
          await ${browserRenderCheckpoint(false)};
          const root = this.document.documentElement;
          // innerWidth/Height round CSS pixels; the visual viewport retains
          // fractions at zoom levels such as 75%. Include scrollbar gutters.
          return {x:this.scrollX,y:this.scrollY,
            width:this.visualViewport.width + this.innerWidth - root.clientWidth,
            height:this.visualViewport.height + this.innerHeight - root.clientHeight,
            clientWidth:root.clientWidth,clientHeight:root.clientHeight,
            left:this.visualViewport.pageLeft,top:this.visualViewport.pageTop,
            visibleWidth:this.visualViewport.width,visibleHeight:this.visualViewport.height,
            scale:this.visualViewport.scale,dpr:this.devicePixelRatio};
        }`,
        arguments: [{ value: position }],
        awaitPromise: true,
        returnByValue: true,
      },
      readSignal
    );
    if (response.exceptionDetails || !response.result?.value) {
      throw new Error('full-page capture lost its document viewport');
    }
    return response.result.value;
  };
  const capture = (area?: BrowserScreenshotRect) => {
    signal?.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('full-page capture timed out');
    guest.invalidate();
    return captureViewportImage(guest, Math.min(remaining, viewportTimeoutMs), signal, area);
  };

  /** The whole page, scaled into the image limits. The page keeps its own
   *  viewport, metrics and layout: it is scrolled band by band, each band is
   *  read from the visible viewport, scaled, and written into the output, so
   *  no bitmap alive is larger than a band or the output. */
  const captureBands = async (start: Viewport): Promise<EncodedBrowserScreenshot> => {
    const zoom = guest.getZoomFactor();
    // DIPs of the view per CSS px: the page zoom and any pinch (a phone
    // layout shown zoomed out) both scale what the viewport shows.
    const dipPerCss = zoom * start.scale;
    // One small read gives the image px per DIP capturePage really delivers
    // (the display's scale, which an emulated pixel ratio does not change),
    // so the band budget and the output size hold for the real images. The
    // strip is a viewport wide: the bitmap's rounding up to a whole pixel
    // then barely moves the measure, and never below the real scale.
    const probeArea = bandCaptureArea({ x: 0, y: 0 }, { width: start.visibleWidth, height: 1 }, dipPerCss);
    const probe = (await capture(probeArea)).getSize();
    if (probe.width <= 0 || probe.height <= 0) throw new Error('full-page capture has no viewport pixels');
    const ratio = (probe.width / probeArea.width) * dipPerCss;
    const plan = fullPageBandPlan(rect, { width: start.visibleWidth, height: start.visibleHeight }, ratio);
    deadline = started + fullPageBandTimeoutMs(plan.bands, timeoutMs, BANDED_CAPTURE_CEILING_MS);
    const native = {
      width: Math.max(1, Math.round(rect.width * ratio)),
      height: Math.max(1, Math.round(rect.height * ratio)),
    };
    const output = fullPageOutputSize(native.width, native.height);
    const bitmap = Buffer.alloc(output.width * output.height * 4);
    for (let y = 0; y < rect.height; y += plan.height) {
      for (let x = 0; x < rect.width; x += plan.width) {
        const band = { x, y, width: Math.min(plan.width, rect.width - x), height: Math.min(plan.height, rect.height - y) };
        const view = await viewport({ x: rect.x + x, y: rect.y + y }, signal);
        // A phone that drops its fit, a resized pane, a pinch or a zoom change
        // moves the page under the plan; a stitched image would no longer be it.
        if (
          view.visibleWidth !== start.visibleWidth ||
          view.visibleHeight !== start.visibleHeight ||
          view.scale !== start.scale ||
          guest.getZoomFactor() !== zoom
        ) {
          throw new Error('the page viewport changed during the full-page capture');
        }
        const offset = { x: Math.max(0, rect.x + x - view.left), y: Math.max(0, rect.y + y - view.top) };
        if (offset.x + band.width > view.visibleWidth + 0.5 || offset.y + band.height > view.visibleHeight + 0.5) {
          throw new Error(
            'full-page capture cannot cover the requested document without missing pixels: ' +
              JSON.stringify({ rect, band, view })
          );
        }
        const area = bandCaptureArea(offset, band, dipPerCss);
        const image = await capture(area);
        const size = image.getSize();
        if (size.width <= 0 || size.height <= 0) throw new Error('full-page capture read an empty band');
        const piece = bandOutputRect(band, rect, output);
        if (piece.width < 1 || piece.height < 1) continue;
        const crop = bandImageCrop(offset, band, dipPerCss, area, size);
        let source = image.crop(crop);
        if (crop.width !== piece.width || crop.height !== piece.height) {
          source = source.resize({ width: piece.width, height: piece.height, quality: 'best' });
        }
        const pixels = source.toBitmap();
        for (let row = 0; row < piece.height; row++) {
          pixels.copy(
            bitmap,
            ((piece.y + row) * output.width + piece.x) * 4,
            row * piece.width * 4,
            (row + 1) * piece.width * 4
          );
        }
      }
    }
    const { width, height, scale } = output;
    const result = encodeImage(nativeImage.createFromBitmap(bitmap, { width, height }), options);
    if (!result) throw new Error('full-page capture exceeded the image budget');
    return scale < 1 ? { ...result, scaledFrom: { ...native, scale } } : result;
  };

  let original: Viewport | undefined;
  const failures: unknown[] = [];
  try {
    original = await viewport(null, signal);
    // Decided from the page's size before any pixel is read: a page past the
    // image limits is read in bands and scaled, never stitched whole.
    const pixelRatio = original.dpr * original.scale;
    if (scaleToFit && fullPageExceedsLimits(rect, pixelRatio)) return await captureBands(original);
    const firstView = await viewport({ x: rect.x, y: rect.y }, signal);
    const firstImage = await capture();
    const firstSize = firstImage.getSize();
    if (firstView.width <= 0 || firstView.height <= 0 || firstSize.width <= 0 || firstSize.height <= 0) {
      throw new Error('full-page capture has no viewport pixels');
    }
    const scaleX = firstSize.width / firstView.width;
    const scaleY = firstSize.height / firstView.height;
    // Chromium reports fractional CSS viewport sizes as float32. Round the
    // raster extent so its representation error cannot invent an extra row.
    const { width, height } = boundedFullPageRect({
      width: Math.round(rect.width * scaleX),
      height: Math.round(rect.height * scaleY),
    });
    const stepX = Math.floor(firstView.clientWidth * scaleX);
    const stepY = Math.floor(firstView.clientHeight * scaleY);
    if (stepX <= 0 || stepY <= 0) throw new Error('full-page capture has no scrollable viewport');
    const bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const first = x === 0 && y === 0;
        const view = first ? firstView : await viewport({ x: rect.x + x / scaleX, y: rect.y + y / scaleY }, signal);
        const image = first ? firstImage : await capture();
        const size = image.getSize();
        const sx = x - Math.round((view.x - rect.x) * scaleX);
        const sy = y - Math.round((view.y - rect.y) * scaleY);
        const tileWidth = Math.min(stepX, width - x);
        const tileHeight = Math.min(stepY, height - y);
        if (
          size.width !== firstSize.width ||
          size.height !== firstSize.height ||
          sx < 0 ||
          sy < 0 ||
          sx + tileWidth > size.width ||
          sy + tileHeight > size.height
        ) {
          throw new Error(
            'full-page capture cannot cover the requested document without missing pixels: ' +
              JSON.stringify({ rect, firstView, view, firstSize, size, x, y, sx, sy, tileWidth, tileHeight })
          );
        }
        const pixels = image.toBitmap();
        for (let row = 0; row < tileHeight; row++) {
          const start = ((sy + row) * size.width + sx) * 4;
          pixels.copy(bitmap, ((y + row) * width + x) * 4, start, start + tileWidth * 4);
        }
      }
    }
    const result = encodeImage(nativeImage.createFromBitmap(bitmap, { width, height }), options);
    if (!result) throw new Error('full-page capture exceeded the image budget');
    return result;
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    try {
      if (original) await viewport({ x: original.x, y: original.y });
      await cdp.call(guest, 'Runtime.releaseObject', { objectId });
    } catch (error) {
      failures.push(error);
      throw new BrowserScreenshotRestoreError('scroll', failures);
    }
  }
}
