/**
 * Zoom geometry: the requested image-space region validated against the frame
 * it names, mapped to physical pixels, and the base surface rectangle a fresh
 * shot is cut from. The zoom frame it records keeps the parent's window or
 * display identity so later commands still address the same surface.
 */
import type { NativeImage } from 'electron';

import type { CaptureFrame, ComputerCommand } from '../shared/types';
import { fitCaptureImage } from './capture-sources';
import type { Rect } from './screenshot-target';

export type ZoomRegion = [number, number, number, number];

export interface ZoomGeometry {
  /** The region in frame image coordinates, as requested. */
  region: ZoomRegion;
  /** The same region in physical screen pixels. */
  physical: { x0: number; y0: number; x1: number; y1: number };
  /** The full surface the parent frame was cut from. */
  base: Rect;
}

export function zoomRegionOf(command: ComputerCommand): ZoomRegion {
  const region = command.region;
  if (!Array.isArray(region) || region.length !== 4 || region.some((value) => !Number.isInteger(value))) {
    throw new Error('zoom requires region [x0,y0,x1,y1] in frame_id image coordinates');
  }
  return region as ZoomRegion;
}

export function zoomGeometry(frame: CaptureFrame, region: ZoomRegion): ZoomGeometry {
  const [fx0, fy0, fx1, fy1] = region;
  if (fx0 < 0 || fy0 < 0 || fx1 > frame.captureWidth || fy1 > frame.captureHeight || fx1 - fx0 < 8 || fy1 - fy0 < 8) {
    // Naming the corners and echoing what arrived separates "outside the frame"
    // from the common mistake of sending a width and height instead of x1,y1.
    throw new Error(
      `zoom region [x0,y0,x1,y1] must be at least 8x8 and inside frame ${frame.captureWidth}x${frame.captureHeight}; received [${region.join(',')}]`
    );
  }
  const physical = {
    x0: frame.originX + Math.round((fx0 * frame.physicalWidth) / frame.captureWidth),
    y0: frame.originY + Math.round((fy0 * frame.physicalHeight) / frame.captureHeight),
    x1: frame.originX + Math.round((fx1 * frame.physicalWidth) / frame.captureWidth),
    y1: frame.originY + Math.round((fy1 * frame.physicalHeight) / frame.captureHeight),
  };
  const base =
    frame.kind === 'window'
      ? { x: frame.windowX, y: frame.windowY, width: frame.windowWidth, height: frame.windowHeight }
      : { x: frame.displayX, y: frame.displayY, width: frame.displayWidth, height: frame.displayHeight };
  if (base.x === undefined || base.y === undefined || base.width === undefined || base.height === undefined) {
    throw new Error(`stale_frame: capture source geometry is missing (${frame.id})`);
  }
  return { region, physical, base: base as Rect };
}

/** The physical zoom rectangle cut out of `shot`, which covers `base`, then
 *  fitted to the width cap. */
export function cropZoom(shot: NativeImage, geometry: ZoomGeometry, maxWidth: number): NativeImage {
  const shotSize = shot.getSize();
  const { physical, base } = geometry;
  const kx = shotSize.width / base.width;
  const ky = shotSize.height / base.height;
  const cropX = Math.min(shotSize.width - 1, Math.max(0, Math.round((physical.x0 - base.x) * kx)));
  const cropY = Math.min(shotSize.height - 1, Math.max(0, Math.round((physical.y0 - base.y) * ky)));
  const cropW = Math.min(shotSize.width - cropX, Math.max(1, Math.round((physical.x1 - physical.x0) * kx)));
  const cropH = Math.min(shotSize.height - cropY, Math.max(1, Math.round((physical.y1 - physical.y0) * ky)));
  return fitCaptureImage(shot.crop({ x: cropX, y: cropY, width: cropW, height: cropH }), maxWidth);
}

export function zoomFrame(
  frame: CaptureFrame,
  geometry: ZoomGeometry,
  input: { frameId: string; sessionId: string; sourceId: string; captureSize: { width: number; height: number } }
): CaptureFrame {
  const { physical } = geometry;
  return {
    id: input.frameId,
    sessionId: input.sessionId,
    capturedAt: performance.now(),
    kind: frame.kind,
    sourceId: input.sourceId,
    ...(frame.nativeBackend ? { nativeBackend: frame.nativeBackend } : {}),
    ...(frame.windowId ? { windowId: frame.windowId } : {}),
    ...(frame.relatedWindowIds ? { relatedWindowIds: frame.relatedWindowIds } : {}),
    ...(frame.displayId ? { displayId: frame.displayId } : {}),
    originX: physical.x0,
    originY: physical.y0,
    physicalWidth: physical.x1 - physical.x0,
    physicalHeight: physical.y1 - physical.y0,
    captureWidth: input.captureSize.width,
    captureHeight: input.captureSize.height,
    ...(frame.windowId
      ? {
          windowX: frame.windowX,
          windowY: frame.windowY,
          windowWidth: frame.windowWidth,
          windowHeight: frame.windowHeight,
          targetWindowX: frame.targetWindowX,
          targetWindowY: frame.targetWindowY,
          targetWindowWidth: frame.targetWindowWidth,
          targetWindowHeight: frame.targetWindowHeight,
        }
      : {
          displayX: frame.displayX,
          displayY: frame.displayY,
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
        }),
  };
}
