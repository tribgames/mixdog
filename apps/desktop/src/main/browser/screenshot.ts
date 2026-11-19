import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import { timedBrowserOperation } from './timing';
import { createElementCapture } from './screenshot-element';
import { BrowserScreenshotRestoreError, captureViaCdp, captureViaNative } from './screenshot-engines';
import { anchorPinnedLayout, fullPageRect } from './screenshot-full-page';
import type { EncodedBrowserScreenshot, ScreenshotCropInput } from './screenshot-image';
import { captureTiledDocument } from './screenshot-tiles';
import { normalizeScreenshotOptions } from './screenshot-policy';
export {
  normalizeScreenshotOptions,
  type BrowserScreenshotFormat,
  type BrowserScreenshotOptions,
} from './screenshot-policy';
/** The display stream's existing base64 frame, separate from tool captures. */
export type BrowserScreenshotCapture = Omit<EncodedBrowserScreenshot, 'bytes' | 'base64'> & { data: string };
type EngineName = 'CDP' | 'native';
type Engines = Record<EngineName, () => Promise<ScreenshotCropInput | null>>;

/** The first engine that yields a usable image wins; every miss is kept so
 *  the final failure names what each engine said. A failed rollback and a
 *  caller's abort end the attempt outright. */
async function firstUsableCapture(
  engines: Engines,
  order: readonly EngineName[],
  signal?: AbortSignal
): Promise<ScreenshotCropInput> {
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
  nativeTimeoutMs: number,
  visualPrivacy?: import('./visual-privacy').BrowserVisualPrivacy
) {
  const slow = { timeoutMs: screenshotTimeoutMs };

  async function capture(
    guest: WebContents,
    background: boolean,
    rawOptions: {
      format?: unknown;
      quality?: unknown;
      fullPage?: unknown;
    } = {},
    signal?: AbortSignal,
    retainCropSource = false
  ): Promise<ScreenshotCropInput> {
    const options = normalizeScreenshotOptions(rawOptions);
    signal?.throwIfAborted();
    const finishPrivacyCheck = await visualPrivacy?.(guest, signal);
    const failures: unknown[] = [];
    try {
      if (options.fullPage) await anchorPinnedLayout(cdp, guest, true, signal);
      const fullPageClip = options.fullPage ? await fullPageRect(cdp, slow, guest, signal) : undefined;
      if (fullPageClip) {
        const data = await captureTiledDocument(
          cdp,
          guest,
          fullPageClip,
          options,
          screenshotTimeoutMs,
          nativeTimeoutMs,
          signal
        );
        return { ...data, pageRect: fullPageClip };
      }
      try {
        guest.invalidate();
      } catch {
        /* teardown can reject repaint */
      }
      const engines: Engines = {
        CDP: () => captureViaCdp(cdp, slow, guest, options, signal, retainCropSource),
        native: () => captureViaNative(guest, options, nativeTimeoutMs, signal),
      };
      const order: EngineName[] = background ? ['native', 'CDP'] : ['CDP', 'native'];
      return await firstUsableCapture(engines, order, signal);
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
      if (!failures.length) await finishPrivacyCheck?.();
    }
  }

  return {
    prepareVisualOutput: (guest: WebContents, signal?: AbortSignal) => visualPrivacy?.(guest, signal),
    capture: timedBrowserOperation(
      'screenshot',
      (
        guest: WebContents,
        background: boolean,
        options?: Parameters<typeof capture>[2],
        signal?: AbortSignal
      ): Promise<EncodedBrowserScreenshot> => capture(guest, background, options, signal)
    ),
    captureElement: timedBrowserOperation(
      'screenshot',
      createElementCapture((guest, background, options, signal) => capture(guest, background, options, signal, true))
    ),
  };
}
