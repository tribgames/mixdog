/** Zoom capture: a cropped, re-encoded region of a frame the session holds. */
import { attachCaptureAttempts, type CaptureAttempt } from '../shared/capture-attempts';
import { DEFAULT_OCR_MAX_WORDS } from '../shared/common';
import type { ComputerCommand, PixelUnavailable } from '../shared/types';
import type { PixelCaptureHost } from './capture-pixels';
import type { createCaptureSources } from './capture-sources';
import { frameQualityIssue } from './frame-quality';
import { screenshotEncoding } from './screenshot-target';
import { cropZoom, zoomFrame, zoomGeometry, zoomRegionOf } from './zoom-region';
import { acquireZoomShot } from './zoom-shot';

export interface ZoomCapture {
  image?: { mimeType: string; data: string };
  description: string;
  frameId?: string;
  pixelUnavailable?: PixelUnavailable;
  captureAttempts?: CaptureAttempt[];
}

export function createZoomCapture(host: PixelCaptureHost, sources: ReturnType<typeof createCaptureSources>) {
  const {
    sessionIdFor,
    assertExecutionNotAborted,
    rememberFrame,
    requireValidFrame,
    framesBySession,
    allocateFrameId,
  } = host;

  /** Zoom exists to resolve what the full frame could not, so the crop answers
   *  with its own recognized text instead of sending the caller back to the
   *  capture that already failed on these pixels. OCR reads the encoded crop,
   *  so its boxes are already this frame's coordinates. */
  async function recognizeZoomText(command: ComputerCommand, jpeg: Buffer): Promise<string> {
    if (command.include_ocr !== true) return '';
    try {
      const ocr = await host.callPowerShell(
        {
          action: 'ocr_image',
          image_base64: jpeg.toString('base64'),
          ocr_language: command.ocr_language ?? null,
          max_ocr_words: DEFAULT_OCR_MAX_WORDS,
          session_id: sessionIdFor(command),
          read_only: true,
        },
        5_000
      );
      if (!ocr.ok) throw new Error(ocr.error || 'recognition failed');
      const lines = Array.isArray(ocr.result?.lines) ? (ocr.result?.lines as Record<string, unknown>[]) : [];
      if (!lines.length) return '\nOCR recognized no text in this region.';
      const rows = lines.map(
        (line) =>
          `[${Number(line.x)},${Number(line.y)} ${Number(line.width)}x${Number(line.height)}] ${String(line.text)}`
      );
      return (
        `\nOCR ${rows.length} lines, language ${String(ocr.result?.language || '')};` +
        ` boxes are pixels in this frame:\n${rows.join('\n')}`
      );
    } catch (error) {
      // Unreadable text is a reason to keep the pixels, never to fail the crop.
      return `\nOCR unavailable: ${(error as Error).message}`;
    }
  }

  return async function captureZoom(command: ComputerCommand): Promise<ZoomCapture | null> {
    const { quality, maxWidth } = screenshotEncoding(command);
    const region = zoomRegionOf(command);
    const frame = await requireValidFrame(command);
    const observationGuard = host.beginObservation(frame.windowId || '');
    const captureAttempts: CaptureAttempt[] = [];
    try {
      await host.authorizeCapture?.(command, frame.windowId || '');
      assertExecutionNotAborted();
      const geometry = zoomGeometry(frame, region);
      const { shot, sourceId } = await acquireZoomShot(sources, command, frame, geometry.base, captureAttempts);
      assertExecutionNotAborted();
      const shotSize = shot.getSize();
      if (!shotSize.width || !shotSize.height) return null;
      const image = cropZoom(shot, geometry, maxWidth);
      const finalSize = image.getSize();
      const { physical } = geometry;
      const qualityIssue = frameQualityIssue(image, physical.x1 - physical.x0, physical.y1 - physical.y0);
      if (qualityIssue) return { description: qualityIssue.message, pixelUnavailable: qualityIssue, captureAttempts };
      const jpeg = image.toJPEG(quality);
      if (!jpeg || jpeg.length === 0) return null;
      assertExecutionNotAborted();
      const zoomFrameId = `frame-${allocateFrameId()}`;
      framesBySession.get(sessionIdFor(command))?.clear();
      rememberFrame(
        zoomFrame(frame, geometry, {
          frameId: zoomFrameId,
          sessionId: sessionIdFor(command),
          sourceId,
          captureSize: finalSize,
        })
      );
      const [fx0, fy0, fx1, fy1] = region;
      const recognized = await recognizeZoomText(command, jpeg);
      return {
        captureAttempts,
        image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
        frameId: zoomFrameId,
        description:
          `Zoom of ${frame.id} region (${fx0},${fy0})-(${fx1},${fy1})` +
          ` (${finalSize.width}x${finalSize.height}, ${jpeg.length} bytes, JPEG quality ${quality});` +
          ` frame_id=${zoomFrameId}; coordinates are pixels in this frame` +
          recognized,
      };
    } catch (error) {
      throw attachCaptureAttempts(error, captureAttempts);
    } finally {
      observationGuard.close();
    }
  };
}
