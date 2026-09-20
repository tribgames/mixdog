import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import { timedBrowserOperation } from './timing';
import { createElementCapture } from './screenshot-element';
import {
  BrowserScreenshotRestoreError,
  captureViaCdp,
  captureViaNative,
  type BrowserScreenshotCapture,
} from './screenshot-engines';
import { anchorPinnedLayout, fullPageRect } from './screenshot-full-page';
import { normalizeScreenshotOptions } from './screenshot-policy';
export {
  normalizeScreenshotOptions,
  type BrowserScreenshotFormat,
  type BrowserScreenshotOptions,
} from './screenshot-policy';
export type { BrowserScreenshotCapture } from './screenshot-engines';

type EngineName = 'CDP' | 'native';
type Engines = Record<EngineName, () => Promise<BrowserScreenshotCapture | null>>;

/** The first engine that yields a usable image wins; every miss is kept so
 *  the final failure names what each engine said. A failed rollback and a
 *  caller's abort end the attempt outright. */
async function firstUsableCapture(
  engines: Engines,
  order: readonly EngineName[],
  signal?: AbortSignal
): Promise<BrowserScreenshotCapture> {
  const errors: Error[] = [];
  for (const name of order) {
    try {
      signal?.throwIfAborted();
      const data = await engines[name]();
      signal?.throwIfAborted();
      if (data) return data;
      throw new Error('no usable screenshot within the requested dimensions and image limits');
    } catch (error) {
      if (error instanceof BrowserScreenshotRestoreError) throw error;
      if (signal?.aborted) throw signal.reason || error;
      errors.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  throw new AggregateError(errors, `screenshot capture failed; ${errors.map((error) => error.message).join('; ')}`);
}

export function createBrowserScreenshotService(
  cdp: BrowserCdpPort,
  screenshotTimeoutMs: number,
  nativeTimeoutMs: number
) {
  const slow = { timeoutMs: screenshotTimeoutMs };
  const nativeTimeouts = { fullPageMs: screenshotTimeoutMs, viewportMs: nativeTimeoutMs };

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
      if (options.fullPage) await anchorPinnedLayout(cdp, guest, true, signal);
      const fullPageClip = options.fullPage ? await fullPageRect(cdp, slow, guest, signal) : undefined;
      try {
        guest.invalidate();
      } catch {
        /* teardown can reject repaint */
      }
      const engines: Engines = {
        CDP: () => captureViaCdp(cdp, slow, guest, options, fullPageClip, signal),
        native: () => captureViaNative(guest, options, nativeTimeouts, fullPageClip, background, signal),
      };
      const data = await firstUsableCapture(engines, background ? ['native', 'CDP'] : ['CDP', 'native'], signal);
      return fullPageClip ? { ...data, pageRect: fullPageClip } : data;
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      if (options.fullPage) {
        try {
          await anchorPinnedLayout(cdp, guest, false);
        } catch (error) {
          failures.push(error);
          throw new BrowserScreenshotRestoreError('layout', failures);
        }
      }
    }
  }

  return {
    capture: timedBrowserOperation('screenshot', capture),
    captureElement: timedBrowserOperation('screenshot', createElementCapture(capture)),
  };
}
