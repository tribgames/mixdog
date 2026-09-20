/** Full-page capture support: pinning the page layout for the duration of the
 *  capture, and measuring the document box that the capture clips. */
import type { Rectangle, WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import {
  assertFullPageOutputBounds,
  boundedFullPageRect,
  FULL_PAGE_LAYOUT_PREPARE,
  FULL_PAGE_LAYOUT_RESTORE,
} from './screenshot-policy';

export async function anchorPinnedLayout(
  cdp: BrowserCdpPort,
  guest: WebContents,
  prepare: boolean,
  signal?: AbortSignal
): Promise<void> {
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

export async function fullPageRect(
  cdp: BrowserCdpPort,
  slow: { timeoutMs: number },
  guest: WebContents,
  signal?: AbortSignal
): Promise<Rectangle> {
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
