/**
 * Cropping a capture down to one element. The page is measured in CSS pixels
 * and the image in device pixels, so the element box is scaled by the ratio
 * between them and clamped to what the capture actually contains: a crop that
 * ran past the image would show something other than what was asked for.
 */
import type { BrowserScreenshotRect } from './screenshot-policy';

export interface BrowserScreenshotClip {
  rect: BrowserScreenshotRect;
  /** The element runs past the viewport, so the image shows only part of it. */
  partial: boolean;
}

export function screenshotClipForElement(
  element: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  image: { width: number; height: number }
): BrowserScreenshotClip {
  if (!(viewport.width > 0) || !(viewport.height > 0) || !(image.width > 0) || !(image.height > 0)) {
    throw new Error('element screenshot requires a measured viewport and image');
  }
  const left = Math.max(0, element.x);
  const top = Math.max(0, element.y);
  const right = Math.min(viewport.width, element.x + element.width);
  const bottom = Math.min(viewport.height, element.y + element.height);
  if (right - left < 1 || bottom - top < 1) {
    throw new Error('the element is outside the viewport; scroll it into view and take the screenshot again');
  }
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  const x = Math.min(image.width - 1, Math.floor(left * scaleX));
  const y = Math.min(image.height - 1, Math.floor(top * scaleY));
  return {
    rect: {
      x,
      y,
      width: Math.max(1, Math.min(image.width - x, Math.ceil(right * scaleX) - x)),
      height: Math.max(1, Math.min(image.height - y, Math.ceil(bottom * scaleY) - y)),
    },
    // Sub-pixel rounding is not a missing region; only a real clip is reported.
    partial: right - left < element.width - 1 || bottom - top < element.height - 1,
  };
}
