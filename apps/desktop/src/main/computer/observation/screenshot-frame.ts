/**
 * What a screenshot leaves behind: the frame record later commands address
 * by id, and the reply built from it. Every field a click or zoom will need
 * to map image pixels back to the screen is fixed here, once.
 */
import type { CaptureAttempt } from '../shared/capture-attempts';
import type { CaptureFrame, PixelUnavailable, ScreenshotCapture } from '../shared/types';
import type { createCaptureSources } from './capture-sources';
import type { Rect, ScreenshotTarget } from './screenshot-target';

export type SelectedSurface = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createCaptureSources>['select']>>['surface']
>;

/** The reply for a capture that produced no usable pixels. */
export function unavailableCapture(
  captureAttempts: CaptureAttempt[],
  windowId: string,
  unavailable: PixelUnavailable
): ScreenshotCapture {
  return {
    captureAttempts,
    description: unavailable.message,
    ...(windowId ? { windowId } : {}),
    pixelUnavailable: unavailable,
  };
}

export function screenshotFrame(input: {
  frameId: string;
  sessionId: string;
  target: ScreenshotTarget;
  surface: SelectedSurface;
  geometry: Rect;
  captureSize: { width: number; height: number };
}): CaptureFrame {
  const { frameId, sessionId, target, surface, geometry, captureSize } = input;
  const { windowId, displayId } = target;
  return {
    id: frameId,
    sessionId,
    capturedAt: performance.now(),
    kind: target.sourceType,
    sourceId: surface.sourceId,
    ...(surface.nativeBackend ? { nativeBackend: surface.nativeBackend } : {}),
    ...(windowId ? { windowId } : {}),
    ...(displayId ? { displayId } : {}),
    originX: geometry.x,
    originY: geometry.y,
    physicalWidth: geometry.width,
    physicalHeight: geometry.height,
    ...(windowId ? { relatedWindowIds: target.relatedWindowIds || [windowId] } : {}),
    captureWidth: captureSize.width,
    captureHeight: captureSize.height,
    ...(windowId
      ? {
          windowX: geometry.x,
          windowY: geometry.y,
          windowWidth: geometry.width,
          windowHeight: geometry.height,
          targetWindowX: target.targetWindow.x,
          targetWindowY: target.targetWindow.y,
          targetWindowWidth: target.targetWindow.width,
          targetWindowHeight: target.targetWindow.height,
        }
      : {
          displayX: geometry.x,
          displayY: geometry.y,
          displayWidth: geometry.width,
          displayHeight: geometry.height,
        }),
  };
}

export function screenshotCapture(input: {
  frame: CaptureFrame;
  target: ScreenshotTarget;
  surface: SelectedSurface;
  jpeg: Buffer;
  quality: number;
  captureAttempts: CaptureAttempt[];
  includeOcrPixels: boolean;
}): ScreenshotCapture {
  const { frame, target, surface, jpeg, quality, captureAttempts, includeOcrPixels } = input;
  const subject =
    target.sourceType === 'window' ? `window "${surface.sourceName || target.sourceTitle}"` : target.sourceTitle;
  return {
    route: surface.route,
    captureAttempts,
    image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
    ...(includeOcrPixels
      ? { ocrImage: { data: surface.image.toPNG().toString('base64'), ...surface.image.getSize() } }
      : {}),
    description:
      `Screenshot of ${subject}` +
      ` (${frame.captureWidth}x${frame.captureHeight}, ${jpeg.length} bytes, JPEG quality ${quality});` +
      ` frame_id=${frame.id}` +
      `${target.windowId ? ` window_id=${target.windowId}` : ''}; coordinates are pixels in this frame`,
    frameId: frame.id,
    ...(target.windowId ? { windowId: target.windowId } : {}),
    frame,
  };
}
