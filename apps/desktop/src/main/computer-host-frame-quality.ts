/**
 * Whether a captured frame carries usable pixels. A frame whose shape does not
 * match the target's coordinate space, or that is effectively one flat colour,
 * is refused here so no coordinate frame is ever issued for it. The judgment is
 * decided by the image alone, which is why it lives outside the capture engine.
 */
import type { NativeImage } from 'electron';

import { pixelUnavailable } from './computer-host-observation';
import {
  SCREENSHOT_CHROME_MARGIN,
  SCREENSHOT_NEAR_BLACK_CHANNEL,
  SCREENSHOT_NEAR_WHITE_CHANNEL,
  SCREENSHOT_SAMPLE_LIMIT,
  SCREENSHOT_UNUSABLE_RATIO,
} from './computer-host-shared';
import type { PixelUnavailable } from './computer-host-types';

export function frameQualityIssue(
  image: NativeImage,
  expectedWidth: number,
  expectedHeight: number,
): PixelUnavailable | undefined {
  const size = image.getSize();
  if (!size.width || !size.height || image.isEmpty()) {
    return pixelUnavailable('empty_frame', 'capture returned an empty pixel frame');
  }
  const expectedAspectRatio = expectedWidth / Math.max(1, expectedHeight);
  const actualAspectRatio = size.width / Math.max(1, size.height);
  const aspectError = Math.abs(actualAspectRatio - expectedAspectRatio)
    / Math.max(0.0001, expectedAspectRatio);
  if (!Number.isFinite(aspectError) || aspectError > 0.05) {
    return pixelUnavailable(
      'coordinate_mismatch',
      'capture dimensions do not match the target coordinate space',
      {
        expected_aspect_ratio: Number(expectedAspectRatio.toFixed(4)),
        actual_aspect_ratio: Number(actualAspectRatio.toFixed(4)),
      },
    );
  }
  const bitmap = image.toBitmap();
  const totalPixels = Math.floor(bitmap.length / 4);
  if (!totalPixels) {
    return pixelUnavailable('empty_frame', 'capture returned no readable pixel data');
  }
  // A window's own border and rounded corners are chrome, not content, so
  // blankness is judged on the interior: a 1px frame cannot make an empty
  // capture look usable.
  const margin = Math.min(
    SCREENSHOT_CHROME_MARGIN,
    Math.floor(Math.min(size.width, size.height) / 8),
  );
  const interiorWidth = Math.max(1, size.width - margin * 2);
  const interiorHeight = Math.max(1, size.height - margin * 2);
  const interiorPixels = interiorWidth * interiorHeight;
  const stride = Math.max(1, Math.floor(interiorPixels / SCREENSHOT_SAMPLE_LIMIT));
  let sampled = 0;
  let nearBlack = 0;
  let nearWhite = 0;
  for (let pixel = 0; pixel < interiorPixels; pixel += stride) {
    const offset = ((margin + Math.floor(pixel / interiorWidth)) * size.width
      + margin + (pixel % interiorWidth)) * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    sampled += 1;
    if (red <= SCREENSHOT_NEAR_BLACK_CHANNEL
      && green <= SCREENSHOT_NEAR_BLACK_CHANNEL
      && blue <= SCREENSHOT_NEAR_BLACK_CHANNEL) {
      nearBlack += 1;
    }
    if (red >= SCREENSHOT_NEAR_WHITE_CHANNEL
      && green >= SCREENSHOT_NEAR_WHITE_CHANNEL
      && blue >= SCREENSHOT_NEAR_WHITE_CHANNEL) {
      nearWhite += 1;
    }
  }
  const nearBlackRatio = nearBlack / Math.max(1, sampled);
  if (nearBlackRatio >= SCREENSHOT_UNUSABLE_RATIO) {
    return pixelUnavailable(
      'blank_black_frame',
      'capture is effectively all black; no coordinate frame was issued',
      {
        sampled_pixels: sampled,
        near_black_ratio: Number(nearBlackRatio.toFixed(4)),
      },
    );
  }
  const nearWhiteRatio = nearWhite / Math.max(1, sampled);
  if (nearWhiteRatio >= SCREENSHOT_UNUSABLE_RATIO) {
    return pixelUnavailable(
      'blank_white_frame',
      'capture is effectively all white; no coordinate frame was issued',
      {
        sampled_pixels: sampled,
        near_white_ratio: Number(nearWhiteRatio.toFixed(4)),
      },
    );
  }
  return undefined;
}
