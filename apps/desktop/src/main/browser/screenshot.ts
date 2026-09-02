import type { Rectangle, WebContents } from 'electron';
import { BrowserWindow, nativeImage } from 'electron';

import {
  assertFullPageOutputBounds,
  browserScreenshotBytesFitBudget,
  boundedFullPageRect,
  normalizeScreenshotOptions,
  scaledScreenshotRect,
  type BrowserScreenshotOptions,
} from './screenshot-policy';
export {
  normalizeScreenshotOptions,
  type BrowserScreenshotFormat,
  type BrowserScreenshotOptions,
} from './screenshot-policy';

export interface BrowserScreenshotCapture {
  data: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
  fullPage: boolean;
}

type SendBrowserCdp = <T>(
  guest: WebContents,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<T>;

function encodeImage(
  image: Electron.NativeImage,
  options: BrowserScreenshotOptions,
): BrowserScreenshotCapture | null {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  const data = options.format === 'png'
    ? image.toPNG()
    : image.toJPEG(options.quality);
  if (!browserScreenshotBytesFitBudget(data.length)) return null;
  return {
    data: data.toString('base64'),
    width: size.width,
    height: size.height,
    mimeType: options.format === 'png' ? 'image/png' : 'image/jpeg',
    fullPage: options.fullPage,
  };
}

function decodeImage(
  data: string,
  options: BrowserScreenshotOptions,
): BrowserScreenshotCapture | null {
  if (!data || !browserScreenshotBytesFitBudget(Math.floor(data.length * 3 / 4))) return null;
  return encodeImage(nativeImage.createFromBuffer(Buffer.from(data, 'base64')), options);
}

function coversRect(capture: BrowserScreenshotCapture | null, rect?: Rectangle): boolean {
  return Boolean(
    capture
    && (!rect || (capture.width >= rect.width && capture.height >= rect.height)),
  );
}

export function createBrowserScreenshotService(
  sendCdp: SendBrowserCdp,
  screenshotTimeoutMs: number,
  nativeTimeoutMs: number,
) {
  async function fullPageRect(guest: WebContents, signal?: AbortSignal): Promise<Rectangle> {
    const metrics = await sendCdp<{
      cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
      contentSize?: { x?: number; y?: number; width?: number; height?: number };
    }>(guest, 'Page.getLayoutMetrics', {}, screenshotTimeoutMs, signal);
    const rect = boundedFullPageRect(metrics.cssContentSize || metrics.contentSize || {});
    // CDP's clip scale is the page zoom, so the output allocation can be much
    // larger than the CSS layout. Apply the same pixel ceiling to that result.
    assertFullPageOutputBounds(rect, guest.getZoomFactor());
    return rect;
  }

  async function captureViaCdp(
    guest: WebContents,
    options: BrowserScreenshotOptions,
    fullPageClip?: Rectangle,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotCapture | null> {
    try {
      const scale = fullPageClip ? guest.getZoomFactor() : 1;
      const expectedRect = fullPageClip ? scaledScreenshotRect(fullPageClip, scale) : undefined;
      const shot = await sendCdp<{ data?: string }>(
        guest,
        'Page.captureScreenshot',
        {
          format: options.format,
          ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
          ...(fullPageClip ? {
            captureBeyondViewport: true,
            clip: { ...fullPageClip, scale },
          } : {}),
        },
        screenshotTimeoutMs,
        signal,
      );
      const capture = shot.data ? decodeImage(shot.data, options) : null;
      return coversRect(capture, expectedRect) ? capture : null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return null;
    }
  }

  async function captureViaNative(
    guest: WebContents,
    options: BrowserScreenshotOptions,
    fullPageClip?: Rectangle,
    background = false,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotCapture | null> {
    if (fullPageClip && !background) return null;
    const expectedRect = fullPageClip
      ? scaledScreenshotRect(fullPageClip, guest.getZoomFactor())
      : undefined;
    const owner = fullPageClip && background ? BrowserWindow.fromWebContents(guest) : null;
    const originalSize = owner && !owner.isDestroyed() ? owner.getContentSize() : null;
    try {
      if (owner && originalSize && expectedRect) {
        owner.setContentSize(expectedRect.width, expectedRect.height);
        await new Promise((resolve) => setTimeout(resolve, 50));
        try { guest.invalidate(); } catch { /* teardown can reject repaint */ }
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason || new Error('browser screenshot cancelled'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      const image = await Promise.race([
        guest.capturePage(),
        cancelled,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('capturePage timed out')),
            fullPageClip ? screenshotTimeoutMs : nativeTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
        if (abort) signal?.removeEventListener('abort', abort);
      });
      const capture = encodeImage(image, options);
      return coversRect(capture, expectedRect) ? capture : null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return null;
    } finally {
      if (owner && originalSize && !owner.isDestroyed()) {
        owner.setContentSize(originalSize[0], originalSize[1]);
      }
    }
  }

  async function capture(
    guest: WebContents,
    background: boolean,
    rawOptions: {
      format?: unknown;
      quality?: unknown;
      fullPage?: unknown;
    } = {},
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotCapture> {
    const options = normalizeScreenshotOptions(rawOptions);
    const fullPageClip = options.fullPage ? await fullPageRect(guest, signal) : undefined;
    try { guest.invalidate(); } catch { /* teardown can reject repaint */ }
    const order = background
      ? [
        () => captureViaNative(guest, options, fullPageClip, background, signal),
        () => captureViaCdp(guest, options, fullPageClip, signal),
      ]
      : [
        () => captureViaCdp(guest, options, fullPageClip, signal),
        () => captureViaNative(guest, options, fullPageClip, background, signal),
      ];
    for (const engine of order) {
      const data = await engine();
      if (data) return data;
    }
    throw new Error('screenshot capture failed');
  }

  return { capture };
}
