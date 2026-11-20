/** Viewport capture engines; full documents are assembled from painted tiles. */
import type { WebContents } from 'electron';
import { nativeImage } from 'electron';

import type { BrowserCdpPort } from './cdp';
import { type EncodedBrowserScreenshot, type ScreenshotCropInput, validatedScreenshot } from './screenshot-image';
import { browserScreenshotBytesFitBudget, type BrowserScreenshotOptions } from './screenshot-policy';

export function encodeImage(
  image: Electron.NativeImage,
  options: BrowserScreenshotOptions
): EncodedBrowserScreenshot | null {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  const bytes = options.format === 'png' ? image.toPNG() : image.toJPEG(options.quality);
  if (!browserScreenshotBytesFitBudget(bytes.length)) return null;
  return {
    bytes,
    width: size.width,
    height: size.height,
    mimeType: options.format === 'png' ? 'image/png' : 'image/jpeg',
    fullPage: options.fullPage,
  };
}

/** A failed rollback is terminal: a different capture engine cannot repair it. */
export class BrowserScreenshotRestoreError extends AggregateError {
  constructor(surface: 'viewport' | 'layout' | 'scroll', failures: unknown[]) {
    super(
      failures,
      `full-page screenshot ${surface} restoration failed; ` +
        failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')
    );
    this.name = 'BrowserScreenshotRestoreError';
  }
}

export async function captureViaCdp(
  cdp: BrowserCdpPort,
  slow: { timeoutMs: number },
  guest: WebContents,
  options: BrowserScreenshotOptions,
  signal?: AbortSignal,
  retainCropSource = false
): Promise<ScreenshotCropInput | null> {
  const shot = await cdp.call<{ data?: string }>(
    guest,
    'Page.captureScreenshot',
    {
      format: options.format,
      ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
    },
    signal,
    slow
  );
  return shot.data
    ? validatedScreenshot(shot.data, options, (bytes) => nativeImage.createFromBuffer(bytes), retainCropSource)
    : null;
}

/** `capturePage` (of `area`, in the view's DIPs, or the whole viewport)
 *  bounded by a timeout and the caller's abort signal. */
export async function captureViewportImage(
  guest: WebContents,
  timeoutMs: number,
  signal?: AbortSignal,
  area?: Electron.Rectangle
): Promise<Electron.NativeImage> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason || new Error('browser screenshot cancelled'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([
    area ? guest.capturePage(area) : guest.capturePage(),
    cancelled,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('capturePage timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener('abort', abort);
  });
}

export async function captureViaNative(
  guest: WebContents,
  options: BrowserScreenshotOptions,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<EncodedBrowserScreenshot | null> {
  if (options.fullPage) return null;
  signal?.throwIfAborted();
  return encodeImage(await captureViewportImage(guest, timeoutMs, signal), options);
}
