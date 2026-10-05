/** Pixel acquisition; no accessibility state. Zoom lives in capture-zoom. */
import { attachCaptureAttempts, type CaptureAttempt } from '../shared/capture-attempts';
import type { ComputerCommand, ScreenshotCapture } from '../shared/types';
import { pixelUnavailable } from './analysis';
import type { CaptureEngineHost } from './capture';
import { createCaptureSources, fitCaptureImage } from './capture-sources';
import { createZoomCapture } from './capture-zoom';
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

export function createPixelCapture(host: PixelCaptureHost) {
  const { sessionIdFor, assertExecutionNotAborted, rememberFrame, allocateFrameId } = host;

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
        client: target.client,
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

  return { captureScreenshot, captureZoom: createZoomCapture(host, sources) };
}
