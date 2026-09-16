import type { Rectangle, WebContents } from 'electron';
import { BrowserWindow, nativeImage } from 'electron';

import type { BrowserCdpPort } from './cdp';
import { timedBrowserOperation } from './timing';
import { pause } from './settle';
import { validatedScreenshot } from './screenshot-image';
import {
  assertFullPageOutputBounds,
  browserScreenshotBytesFitBudget,
  boundedFullPageRect,
  FULL_PAGE_LAYOUT_PREPARE,
  FULL_PAGE_LAYOUT_RESTORE,
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

function encodeImage(image: Electron.NativeImage, options: BrowserScreenshotOptions): BrowserScreenshotCapture | null {
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
class BrowserScreenshotRestoreError extends AggregateError {
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

export function createBrowserScreenshotService(
  cdp: BrowserCdpPort,
  screenshotTimeoutMs: number,
  nativeTimeoutMs: number
) {
  const slow = { timeoutMs: screenshotTimeoutMs };
  async function anchorPinnedLayout(guest: WebContents, prepare: boolean, signal?: AbortSignal): Promise<void> {
    const response = await cdp.call<{
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      guest,
      'Runtime.evaluate',
      { expression: prepare ? FULL_PAGE_LAYOUT_PREPARE : FULL_PAGE_LAYOUT_RESTORE, returnByValue: true },
      signal
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
  }
  async function fullPageRect(guest: WebContents, signal?: AbortSignal): Promise<Rectangle> {
    const metrics = await cdp.call<{
      cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
      contentSize?: { x?: number; y?: number; width?: number; height?: number };
    }>(guest, 'Page.getLayoutMetrics', {}, signal, slow);
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

  async function captureViaNative(
    guest: WebContents,
    options: BrowserScreenshotOptions,
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
            fullPageClip ? screenshotTimeoutMs : nativeTimeoutMs
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
        if (abort) signal?.removeEventListener('abort', abort);
      });
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

  async function capture(
    guest: WebContents,
    background: boolean,
    rawOptions: {
      format?: unknown;
      quality?: unknown;
      fullPage?: unknown;
    } = {},
    signal?: AbortSignal
  ): Promise<BrowserScreenshotCapture> {
    const options = normalizeScreenshotOptions(rawOptions);
    signal?.throwIfAborted();
    const failures: unknown[] = [];
    try {
      if (options.fullPage) await anchorPinnedLayout(guest, true, signal);
      const fullPageClip = options.fullPage ? await fullPageRect(guest, signal) : undefined;
      try {
        guest.invalidate();
      } catch {
        /* teardown can reject repaint */
      }
      const engines = {
        CDP: () => captureViaCdp(guest, options, fullPageClip, signal),
        native: () => captureViaNative(guest, options, fullPageClip, background, signal),
      };
      const errors: Error[] = [];
      for (const name of background ? (['native', 'CDP'] as const) : (['CDP', 'native'] as const)) {
        try {
          signal?.throwIfAborted();
          const data = await engines[name]();
          signal?.throwIfAborted();
          if (data) return data;
          throw new Error('no usable screenshot within the requested dimensions and image limits');
        } catch (error) {
          if (error instanceof BrowserScreenshotRestoreError) throw error;
          if (signal?.aborted) throw signal.reason || error;
          errors.push(
            new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
          );
        }
      }
      throw new AggregateError(errors, `screenshot capture failed; ${errors.map((error) => error.message).join('; ')}`);
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      if (options.fullPage) {
        try {
          await anchorPinnedLayout(guest, false);
        } catch (error) {
          failures.push(error);
          throw new BrowserScreenshotRestoreError('layout', failures);
        }
      }
    }
  }

  return { capture: timedBrowserOperation('screenshot', capture) };
}
