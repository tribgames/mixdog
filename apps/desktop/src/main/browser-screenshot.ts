import type { Rectangle, WebContents } from 'electron';
import { BrowserWindow, nativeImage } from 'electron';

export type BrowserScreenshotFormat = 'jpeg' | 'png';

export interface BrowserScreenshotOptions {
  format: BrowserScreenshotFormat;
  quality: number;
  fullPage: boolean;
}

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

const DEFAULT_QUALITY = 75;
const MAX_FULL_PAGE_DIMENSION = 32_768;
const MAX_FULL_PAGE_PIXELS = 24_000_000;

export function normalizeScreenshotOptions(input: {
  format?: unknown;
  quality?: unknown;
  fullPage?: unknown;
}): BrowserScreenshotOptions {
  const format = String(input.format || 'jpeg').trim().toLowerCase();
  if (format !== 'jpeg' && format !== 'png') {
    throw new Error('snapshot format must be jpeg or png');
  }
  if (format === 'png' && input.quality !== undefined) {
    throw new Error('snapshot quality is supported only with format=jpeg');
  }
  const rawQuality = input.quality === undefined ? DEFAULT_QUALITY : Number(input.quality);
  if (!Number.isFinite(rawQuality) || rawQuality < 0 || rawQuality > 100) {
    throw new Error('snapshot quality must be between 0 and 100');
  }
  return {
    format,
    quality: Math.round(rawQuality),
    fullPage: input.fullPage === true,
  };
}

function encodeImage(
  image: Electron.NativeImage,
  options: BrowserScreenshotOptions,
): BrowserScreenshotCapture | null {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  const data = options.format === 'png'
    ? image.toPNG()
    : image.toJPEG(options.quality);
  if (!data.length) return null;
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
  if (!data) return null;
  return encodeImage(nativeImage.createFromBuffer(Buffer.from(data, 'base64')), options);
}

function boundedFullPageRect(contentSize: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): Rectangle {
  const x = Math.max(0, Math.floor(Number(contentSize.x) || 0));
  const y = Math.max(0, Math.floor(Number(contentSize.y) || 0));
  const width = Math.ceil(Number(contentSize.width) || 0);
  const height = Math.ceil(Number(contentSize.height) || 0);
  if (width < 1 || height < 1) throw new Error('full-page screenshot has no measurable content');
  if (width > MAX_FULL_PAGE_DIMENSION
    || height > MAX_FULL_PAGE_DIMENSION
    || width * height > MAX_FULL_PAGE_PIXELS) {
    throw new Error(
      `full-page screenshot is too large (${width}x${height}); limit is `
      + `${MAX_FULL_PAGE_DIMENSION}px per side and ${MAX_FULL_PAGE_PIXELS.toLocaleString()} pixels`,
    );
  }
  return { x, y, width, height };
}

function coversRect(capture: BrowserScreenshotCapture | null, rect?: Rectangle): boolean {
  return Boolean(
    capture
    && (!rect || (capture.width >= rect.width && capture.height >= rect.height)),
  );
}

function scaledRect(rect: Rectangle, scale: number): Rectangle {
  return {
    x: Math.floor(rect.x * scale),
    y: Math.floor(rect.y * scale),
    width: Math.ceil(rect.width * scale),
    height: Math.ceil(rect.height * scale),
  };
}

export function createBrowserScreenshotService(
  sendCdp: SendBrowserCdp,
  screenshotTimeoutMs: number,
  nativeTimeoutMs: number,
) {
  async function fullPageRect(guest: WebContents): Promise<Rectangle> {
    const metrics = await sendCdp<{
      cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
      contentSize?: { x?: number; y?: number; width?: number; height?: number };
    }>(guest, 'Page.getLayoutMetrics', {}, screenshotTimeoutMs);
    return boundedFullPageRect(metrics.cssContentSize || metrics.contentSize || {});
  }

  async function captureViaCdp(
    guest: WebContents,
    options: BrowserScreenshotOptions,
    fullPageClip?: Rectangle,
  ): Promise<BrowserScreenshotCapture | null> {
    try {
      const scale = fullPageClip ? guest.getZoomFactor() : 1;
      const expectedRect = fullPageClip ? scaledRect(fullPageClip, scale) : undefined;
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
      );
      const capture = shot.data ? decodeImage(shot.data, options) : null;
      return coversRect(capture, expectedRect) ? capture : null;
    } catch {
      return null;
    }
  }

  async function captureViaNative(
    guest: WebContents,
    options: BrowserScreenshotOptions,
    fullPageClip?: Rectangle,
    background = false,
  ): Promise<BrowserScreenshotCapture | null> {
    if (fullPageClip && !background) return null;
    const expectedRect = fullPageClip
      ? scaledRect(fullPageClip, guest.getZoomFactor())
      : undefined;
    const owner = fullPageClip && background ? BrowserWindow.fromWebContents(guest) : null;
    const originalSize = owner && !owner.isDestroyed() ? owner.getContentSize() : null;
    try {
      if (owner && originalSize && expectedRect) {
        owner.setContentSize(expectedRect.width, expectedRect.height);
        await new Promise((resolve) => setTimeout(resolve, 50));
        try { guest.invalidate(); } catch { /* teardown can reject repaint */ }
      }
      const image = await Promise.race([
        guest.capturePage(),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error('capturePage timed out')),
          fullPageClip ? screenshotTimeoutMs : nativeTimeoutMs,
        )),
      ]);
      const capture = encodeImage(image, options);
      return coversRect(capture, expectedRect) ? capture : null;
    } catch {
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
  ): Promise<BrowserScreenshotCapture> {
    const options = normalizeScreenshotOptions(rawOptions);
    const fullPageClip = options.fullPage ? await fullPageRect(guest) : undefined;
    try { guest.invalidate(); } catch { /* teardown can reject repaint */ }
    const order = background
      ? [captureViaNative, captureViaCdp]
      : [captureViaCdp, captureViaNative];
    for (const engine of order) {
      const data = await engine(guest, options, fullPageClip, background);
      if (data) return data;
    }
    throw new Error('screenshot capture failed');
  }

  return { capture };
}
