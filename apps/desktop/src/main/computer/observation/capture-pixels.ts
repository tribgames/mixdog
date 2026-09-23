/** Pixel acquisition and zoom geometry; no accessibility state. */
import { attachCaptureAttempts, type CaptureAttempt } from '../shared/capture-attempts';
import { DEFAULT_OCR_MAX_WORDS } from '../shared/common';
import type { ComputerCommand, PixelUnavailable, ScreenshotCapture } from '../shared/types';
import { pixelUnavailable } from './analysis';
import type { CaptureEngineHost } from './capture';
import { createCaptureSources, fitCaptureImage } from './capture-sources';
import { frameQualityIssue } from './frame-quality';
import { screenshotCapture, screenshotFrame, unavailableCapture } from './screenshot-frame';
import {
  capturedGeometry,
  displayScreenshotTarget,
  screenshotEncoding,
  targetsWindow,
  windowScreenshotTarget,
  type ScreenshotTarget,
} from './screenshot-target';
import { cropZoom, zoomFrame, zoomGeometry, zoomRegionOf } from './zoom-region';
import { acquireZoomShot } from './zoom-shot';

export type PixelCaptureHost = Pick<
  CaptureEngineHost,
  | 'callPowerShell'
  | 'sessionIdFor'
  | 'assertExecutionNotAborted'
  | 'rememberFrame'
  | 'requireValidFrame'
  | 'framesBySession'
  | 'allocateFrameId'
  | 'authorizeCapture'
  | 'beginObservation'
>;

export interface ZoomCapture {
  image?: { mimeType: string; data: string };
  description: string;
  frameId?: string;
  pixelUnavailable?: PixelUnavailable;
  captureAttempts?: CaptureAttempt[];
}

export function createPixelCapture(host: PixelCaptureHost) {
  const {
    sessionIdFor,
    assertExecutionNotAborted,
    rememberFrame,
    requireValidFrame,
    framesBySession,
    allocateFrameId,
  } = host;

  const sources = createCaptureSources(host);

  /** A child window whose surface could not be read is retried once through
   *  its owner, whose composited surface includes the child. */
  async function captureThroughOwner(
    command: ComputerCommand,
    target: ScreenshotTarget,
    captureAttempts: CaptureAttempt[]
  ): Promise<ScreenshotCapture | null> {
    const ownerCapture = await captureScreenshot(
      { ...command, window: undefined, window_id: target.ownerWindowId },
      false
    );
    captureAttempts.push(
      ...(ownerCapture.captureAttempts || []).map((attempt) => ({ ...attempt, scope: 'owner' as const }))
    );
    if (!(ownerCapture.image && ownerCapture.frame && ownerCapture.frameId)) return null;
    return {
      ...ownerCapture,
      captureAttempts,
      description:
        `${ownerCapture.description}; requested child window ${target.windowId}` +
        ` was captured through owner ${target.ownerWindowId}`,
    };
  }

  async function captureScreenshot(command: ComputerCommand, allowOwnerFallback = true): Promise<ScreenshotCapture> {
    const observationGuard = host.beginObservation(command.window_id || '');
    const captureAttempts: CaptureAttempt[] = [];
    try {
      const { quality, maxWidth } = screenshotEncoding(command);
      const target = targetsWindow(command)
        ? await windowScreenshotTarget(host, command, (windowId) => observationGuard.includeWindow(windowId))
        : displayScreenshotTarget(command);
      await host.authorizeCapture?.(command, target.windowId);
      assertExecutionNotAborted();
      const preserveOcrPixels = command.mode === 'state' || command.mode === 'som' || command.include_ocr === true;
      const selected = await sources.select({
        command,
        sourceType: target.sourceType,
        sourceTitle: target.sourceTitle,
        windowId: target.windowId,
        displayId: target.displayId,
        width: target.geometry.width,
        height: target.geometry.height,
        clientWidth: target.client.width,
        clientHeight: target.client.height,
        maxWidth,
        preserveResolution: preserveOcrPixels,
        attempts: captureAttempts,
      });
      if (!selected.surface) {
        if (
          !selected.terminal &&
          allowOwnerFallback &&
          target.windowId &&
          target.ownerWindowId &&
          target.ownerWindowId !== target.windowId
        ) {
          const ownerCapture = await captureThroughOwner(command, target, captureAttempts);
          if (ownerCapture) return ownerCapture;
        }
        return unavailableCapture(captureAttempts, target.windowId, selected.unavailable!);
      }
      const { surface } = selected;
      const capturedImage = fitCaptureImage(surface.image, maxWidth);
      const captureSize = capturedImage.getSize();
      const geometry = capturedGeometry(target, surface, captureSize);
      const qualityIssue = frameQualityIssue(
        capturedImage,
        geometry.width || target.sourceWidth,
        geometry.height || target.sourceHeight
      );
      if (qualityIssue) return unavailableCapture(captureAttempts, target.windowId, qualityIssue);
      const jpeg = capturedImage.toJPEG(quality);
      if (!jpeg || jpeg.length === 0) {
        return unavailableCapture(
          captureAttempts,
          target.windowId,
          pixelUnavailable('empty_frame', 'capture could not encode a pixel frame')
        );
      }
      assertExecutionNotAborted();
      const frame = screenshotFrame({
        frameId: `frame-${allocateFrameId()}`,
        sessionId: sessionIdFor(command),
        target,
        surface,
        geometry,
        captureSize,
      });
      rememberFrame(frame);
      return screenshotCapture({
        frame,
        target,
        surface,
        jpeg,
        quality,
        captureAttempts,
        includeOcrPixels: preserveOcrPixels,
      });
    } catch (error) {
      throw attachCaptureAttempts(error, captureAttempts);
    } finally {
      observationGuard.close();
    }
  }

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

  async function captureZoom(command: ComputerCommand): Promise<ZoomCapture | null> {
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
  }
  return { captureScreenshot, captureZoom };
}
