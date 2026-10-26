// Local presentation of the remote page's picture (JPEG or video): zoom and
// pan are this device's only; the page keeps its geometry. Input maps back
// through the transformed picture box, so it stays exact at any zoom. This is
// the desktop pane's zoom; the phone's view is remote-viewport.ts.
import type { RemoteWebrtcGeometry } from '../shared/remote-webrtc';
import { BROWSER_ZOOM_MAX, BROWSER_ZOOM_MIN } from './browser-zoom-level';
import type { RemoteInputFrame } from './remote-browser-input-client';

type Pan = { x: number; y: number };

/** Keep a zoomed picture's edges inside the box: it may pan only as far as
 *  its overflow on each axis. */
export function clampPan(offset: number, size: number, zoom: number): number {
  const reach = Math.max(0, (size * (zoom - 1)) / 2);
  return Math.min(reach, Math.max(-reach, offset));
}

/** `ready.videoLimit`'s bound (shared/remote-webrtc.ts MAX_PIXEL_DIMENSION,
 *  not exported; docs/remote-webrtc.md). */
export const REMOTE_VIDEO_LIMIT_MAX = 4_096;

/**
 * The video this device wants for zooming (`ready.videoLimit`): the page at
 * its native size (CSS size × its device scale factor, one video pixel per
 * page device pixel; the desktop never captures larger), bounded by the
 * contract. Zoom past it shows no more detail, so it asks for no more.
 */
export function remoteVideoLimit(
  geometry: Pick<RemoteWebrtcGeometry, 'cssWidth' | 'cssHeight' | 'deviceScaleFactor'>
): { maxWidth: number; maxHeight: number } | null {
  const width = Math.floor(geometry.cssWidth * geometry.deviceScaleFactor);
  const height = Math.floor(geometry.cssHeight * geometry.deviceScaleFactor);
  if (!(width > 0) || !(height > 0)) return null;
  return { maxWidth: Math.min(REMOTE_VIDEO_LIMIT_MAX, width), maxHeight: Math.min(REMOTE_VIDEO_LIMIT_MAX, height) };
}

/** Whether a geometry's video is below the native size `limit` names (the
 *  desktop rounds sizes down to even pixels). */
export function remoteVideoBelowLimit(
  geometry: Pick<RemoteWebrtcGeometry, 'pixelWidth' | 'pixelHeight'>,
  limit: { maxWidth: number; maxHeight: number }
): boolean {
  return geometry.pixelWidth + 1 < limit.maxWidth || geometry.pixelHeight + 1 < limit.maxHeight;
}

/** The pinch ceiling: the menu's maximum, or further while the picture still
 *  has pixels the screen does not show (one source pixel per device pixel). */
export function remotePinchMaxZoom(
  box: { width: number; height: number },
  source: { width: number; height: number } | null,
  devicePixelRatio: number
): number {
  if (!source || !(source.width > 0) || !(source.height > 0) || !(box.width > 0) || !(box.height > 0)) {
    return BROWSER_ZOOM_MAX;
  }
  const fitted = Math.min(box.width / source.width, box.height / source.height) * (devicePixelRatio || 1);
  return Math.max(BROWSER_ZOOM_MAX, 1 / fitted);
}

/**
 * Zoom by `scale` keeping the picture point under client point `at` there,
 * then move it by the fingers' shift. `center` is the box's untransformed
 * centre (the transform origin); the transform is translate(pan) scale(zoom).
 */
export function zoomRemoteView(
  view: { zoom: number; pan: Pan },
  change: { scale: number; at: Pan; shift: Pan; center: Pan; size: { width: number; height: number }; max: number }
): { zoom: number; pan: Pan } {
  const zoom = Math.min(change.max, Math.max(BROWSER_ZOOM_MIN, view.zoom * change.scale));
  const ratio = zoom / view.zoom;
  const axis = (at: number, center: number, pan: number, shift: number, size: number): number =>
    clampPan(at - center - ratio * (at - center - pan) + shift, size, zoom);
  return {
    zoom,
    pan: {
      x: axis(change.at.x, change.center.x, view.pan.x, change.shift.x, change.size.width),
      y: axis(change.at.y, change.center.y, view.pan.y, change.shift.y, change.size.height),
    },
  };
}

/** Input geometry while the video is the picture: the acknowledged geometry,
 *  but only while the presented frame is at its locked pixel size; otherwise
 *  input is refused (0×0) rather than mapped through another size. */
export function remoteVideoInputFrame(
  documentId: string,
  geometry: RemoteWebrtcGeometry | null,
  presented: { width: number; height: number } | null
): RemoteInputFrame {
  const valid =
    geometry !== null && presented?.width === geometry.pixelWidth && presented.height === geometry.pixelHeight;
  return valid
    ? {
        documentId,
        width: geometry.pixelWidth,
        height: geometry.pixelHeight,
        viewportWidth: geometry.cssWidth,
        viewportHeight: geometry.cssHeight,
      }
    : { documentId, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 };
}
