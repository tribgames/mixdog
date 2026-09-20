/** The two screenshot engines behind the browser screenshot service: CDP's
 *  `Page.captureScreenshot`, and Electron's `capturePage` on the guest, which
 *  a full-page request can only use with a resized background window. */
import type { Rectangle, WebContents } from 'electron';
import { BrowserWindow, nativeImage } from 'electron';

import type { BrowserCdpPort } from './cdp';
import { pause } from './settle';
import { validatedScreenshot } from './screenshot-image';
import {
  browserScreenshotBytesFitBudget,
  scaledScreenshotRect,
  type BrowserScreenshotOptions,
  type BrowserScreenshotRect,
} from './screenshot-policy';

export interface BrowserScreenshotCapture {
  data: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
  fullPage: boolean;
  /** The document box a full-page capture clipped, in CSS pixels. */
  pageRect?: BrowserScreenshotRect;
}

export function encodeImage(
  image: Electron.NativeImage,
  options: BrowserScreenshotOptions
): BrowserScreenshotCapture | null {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  const data = options.format === 'png' ? image.toPNG() : image.toJPEG(options.quality);
  if (!browserScreenshotBytesFitBudget(data.length)) return null;
  return {
    data: data.toString('base64'),
    width: size.width,
    height: size.height,
    mimeType: options.format === 'png' ? 'image/png' : 'image/jpeg',
    fullPage: options.fullPage,
  };
}

/** A failed rollback is terminal: a different capture engine cannot repair it. */
export class BrowserScreenshotRestoreError extends AggregateError {
  constructor(surface: 'viewport' | 'layout', failures: unknown[]) {
    super(
      failures,
      `full-page screenshot ${surface} restoration failed; ` +
        failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')
    );
    this.name = 'BrowserScreenshotRestoreError';
  }
}

function coversRect(capture: BrowserScreenshotCapture | null, rect?: Rectangle): boolean {
  return Boolean(capture && (!rect || (capture.width >= rect.width && capture.height >= rect.height)));
}

export async function captureViaCdp(
  cdp: BrowserCdpPort,
  slow: { timeoutMs: number },
  guest: WebContents,
  options: BrowserScreenshotOptions,
  fullPageClip?: Rectangle,
  signal?: AbortSignal
): Promise<BrowserScreenshotCapture | null> {
  const scale = fullPageClip ? guest.getZoomFactor() : 1;
  const expectedRect = fullPageClip ? scaledScreenshotRect(fullPageClip, scale) : undefined;
  const shot = await cdp.call<{ data?: string }>(
    guest,
    'Page.captureScreenshot',
    {
      format: options.format,
      ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
      ...(fullPageClip
        ? {
            captureBeyondViewport: true,
            clip: { ...fullPageClip, scale },
          }
        : {}),
    },
    signal,
    slow
  );
  const capture = shot.data
    ? validatedScreenshot(shot.data, options, (bytes) => nativeImage.createFromBuffer(bytes))
    : null;
  return coversRect(capture, expectedRect) ? capture : null;
}

/** `capturePage` bounded by a timeout and the caller's abort signal. */
async function racedCapturePage(
  guest: WebContents,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Electron.NativeImage> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason || new Error('browser screenshot cancelled'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([
    guest.capturePage(),
    cancelled,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('capturePage timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener('abort', abort);
  });
}

export interface NativeCaptureTimeouts {
  /** Ceiling for a resized full-page background capture. */
  fullPageMs: number;
  /** Ceiling for a plain viewport capture. */
  viewportMs: number;
}

export async function captureViaNative(
  guest: WebContents,
  options: BrowserScreenshotOptions,
  timeouts: NativeCaptureTimeouts,
  fullPageClip?: Rectangle,
  background = false,
  signal?: AbortSignal
): Promise<BrowserScreenshotCapture | null> {
  if (fullPageClip && !background) return null;
  const expectedRect = fullPageClip ? scaledScreenshotRect(fullPageClip, guest.getZoomFactor()) : undefined;
  const owner = fullPageClip && background ? BrowserWindow.fromWebContents(guest) : null;
  const originalSize = owner && !owner.isDestroyed() ? owner.getContentSize() : null;
  const failures: unknown[] = [];
  try {
    if (owner && originalSize && expectedRect) {
      owner.setContentSize(expectedRect.width, expectedRect.height);
      await pause(50, signal);
      try {
        guest.invalidate();
      } catch {
        /* teardown can reject repaint */
      }
    }
    signal?.throwIfAborted();
    const image = await racedCapturePage(guest, fullPageClip ? timeouts.fullPageMs : timeouts.viewportMs, signal);
    const capture = encodeImage(image, options);
    return coversRect(capture, expectedRect) ? capture : null;
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    if (owner && originalSize && !owner.isDestroyed()) {
      try {
        owner.setContentSize(originalSize[0], originalSize[1]);
      } catch (error) {
        failures.push(error);
        throw new BrowserScreenshotRestoreError('viewport', failures);
      }
    }
  }
}
