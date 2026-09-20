/**
 * The image half of a capture reply: frame fields and the SOM overlay burned
 * into the screenshot, and the optional hand-off of the pixels to a file.
 */
import { DEFAULT_SCREENSHOT_QUALITY, elapsedMs } from '../shared/common';
import { persistFrameImage } from '../../frame-files';
import { renderSomOverlay } from './som-overlay';
import { screenshotInteger } from './analysis';
import type { ComputerCommand, ScreenshotCapture } from '../shared/types';
import type { CaptureMode } from './capture-target';

export type CaptureImage = { mimeType: string; data: string };

/** Stamp frame identity on the payload and, for SOM, draw the element marks. */
export async function applyFrameImage(
  payload: Record<string, unknown>,
  timings: Record<string, number>,
  {
    command,
    mode,
    screenshot,
    elements,
  }: {
    command: ComputerCommand;
    mode: CaptureMode;
    screenshot: ScreenshotCapture | null;
    elements: Record<string, unknown>[];
  }
): Promise<CaptureImage | undefined> {
  let image = screenshot?.image;
  if (!screenshot?.frame || !screenshot.frameId) return image;
  payload.frame_id = screenshot.frameId;
  payload.width = screenshot.frame.captureWidth;
  payload.height = screenshot.frame.captureHeight;
  if (mode === 'som' && image) {
    const overlayStartedAt = performance.now();
    const quality = screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality');
    const overlay = await renderSomOverlay(
      image,
      screenshot.frame.captureWidth,
      screenshot.frame.captureHeight,
      elements,
      quality
    );
    image = overlay.image;
    payload.overlay_rendered = overlay.rendered;
    if (overlay.error) payload.overlay_error = overlay.error;
    timings.overlay_ms = elapsedMs(overlayStartedAt);
  }
  return image;
}

/** `image_output: 'file'` moves the pixels to disk; a frame that could not be
 *  written stays inline — the caller asked for a cheaper reply, not for the
 *  pixels to disappear. Returns the image still to send inline. */
export function persistCaptureImage(
  payload: Record<string, unknown>,
  image: CaptureImage | undefined,
  { command, sessionId }: { command: ComputerCommand; sessionId: string }
): CaptureImage | undefined {
  if (!image || String(command.image_output || 'inline') !== 'file') return image;
  const stored = persistFrameImage('computer', sessionId, String(payload.frame_id || ''), image);
  if (!stored) return image;
  payload.image_file = { path: stored.path, bytes: stored.bytes, mime_type: image.mimeType };
  return undefined;
}
