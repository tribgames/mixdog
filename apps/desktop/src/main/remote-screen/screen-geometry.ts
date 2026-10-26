/**
 * Display geometry for the screen source: which displays exist, the locked
 * video geometry of the chosen one, the video-pixel → desktop-pixel pointer
 * mapping, and fitting a secure-desktop helper frame onto that geometry.
 *
 * "Desktop pixels" are physical pixels of the Windows virtual screen (origin
 * at the primary monitor's top-left; negative on monitors left of or above
 * it), the space SendInput's virtual-desk mapping and the helper both use.
 */
import type { RemoteScreenDisplaySummary, RemoteWebrtcGeometry } from '../../shared/remote-webrtc';

/** The contract's pixel bound (remote-webrtc.ts MAX_PIXEL_DIMENSION). */
export const MAX_SCREEN_PIXELS = 4_096;
const MIN_SCREEN_PIXELS = 64;
const MIN_CSS = 200;
const MAX_CSS = 3_840;

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One display as the platform reports it: DIP bounds plus the physical rect. */
export interface ScreenDisplay {
  screenId: string;
  label: string;
  primary: boolean;
  scaleFactor: number;
  /** DIP bounds (Electron `Display.bounds`). */
  bounds: ScreenRect;
  /** Physical desktop-pixel rect (`screen.dipToScreenRect(null, bounds)`). */
  physical: ScreenRect;
  /** The `desktopCapturer` source id whose `display_id` is this display. The
   *  id's own text is not a display id, so the provider resolves it. */
  captureSourceId: string;
}

export interface ScreenPointerMapping {
  generation: number;
  pixelWidth: number;
  pixelHeight: number;
  physical: ScreenRect;
}

export interface LockedScreenGeometry {
  geometry: RemoteWebrtcGeometry;
  mapping: ScreenPointerMapping;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const even = (value: number): number => Math.max(MIN_SCREEN_PIXELS, Math.floor(value / 2) * 2);

export function summarizeScreenDisplay(display: ScreenDisplay): RemoteScreenDisplaySummary {
  return {
    screenId: display.screenId,
    label: display.label,
    primary: display.primary,
    pixelWidth: display.physical.width,
    pixelHeight: display.physical.height,
    scaleFactor: display.scaleFactor,
  };
}

/** The display's native pixel size, scaled down uniformly only when a side
 *  exceeds the contract bound, then made even for 4:2:0 chroma. */
export function screenVideoSize(physical: Pick<ScreenRect, 'width' | 'height'>): { width: number; height: number } {
  if (physical.width < MIN_SCREEN_PIXELS || physical.height < MIN_SCREEN_PIXELS) {
    throw new Error('remote screen display is too small to stream');
  }
  const scale = Math.min(1, MAX_SCREEN_PIXELS / physical.width, MAX_SCREEN_PIXELS / physical.height);
  return { width: even(physical.width * scale), height: even(physical.height * scale) };
}

export function lockScreenGeometry(display: ScreenDisplay, generation: number): LockedScreenGeometry {
  const { width, height } = screenVideoSize(display.physical);
  return {
    geometry: {
      generation,
      cssWidth: clamp(Math.round(display.bounds.width), MIN_CSS, MAX_CSS),
      cssHeight: clamp(Math.round(display.bounds.height), MIN_CSS, MAX_CSS),
      deviceScaleFactor: clamp(display.scaleFactor, 0.5, 4),
      pixelWidth: width,
      pixelHeight: height,
    },
    mapping: { generation, pixelWidth: width, pixelHeight: height, physical: { ...display.physical } },
  };
}

/** True when a display change needs a new geometry generation. */
export function screenGeometryChanged(mapping: ScreenPointerMapping, display: ScreenDisplay): boolean {
  const { physical } = mapping;
  return (
    physical.x !== display.physical.x ||
    physical.y !== display.physical.y ||
    physical.width !== display.physical.width ||
    physical.height !== display.physical.height
  );
}

/** A video-pixel point → the desktop pixel under it, or null outside the
 *  frame. The far edge (x === pixelWidth) lands on the last pixel. */
export function mapScreenPointer(mapping: ScreenPointerMapping, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > mapping.pixelWidth || y > mapping.pixelHeight) return null;
  const { physical } = mapping;
  const column = Math.min(physical.width - 1, Math.floor((x * physical.width) / mapping.pixelWidth));
  const row = Math.min(physical.height - 1, Math.floor((y * physical.height) / mapping.pixelHeight));
  return { x: physical.x + column, y: physical.y + row };
}

/** A desktop pixel → the video pixel showing it (the inverse of
 *  `mapScreenPointer`, to whole pixels), or null when it is not on this
 *  display. */
export function screenPointToVideo(mapping: ScreenPointerMapping, x: number, y: number): { x: number; y: number } | null {
  const { physical } = mapping;
  const column = x - physical.x;
  const row = y - physical.y;
  if (!Number.isFinite(column) || !Number.isFinite(row)) return null;
  if (column < 0 || row < 0 || column >= physical.width || row >= physical.height) return null;
  return {
    x: Math.min(mapping.pixelWidth - 1, Math.floor(((column + 0.5) * mapping.pixelWidth) / physical.width)),
    y: Math.min(mapping.pixelHeight - 1, Math.floor(((row + 0.5) * mapping.pixelHeight) / physical.height)),
  };
}

/** A raw BGRA frame and where its top-left pixel sits on the desktop. */
export interface ScreenBgraFrame {
  width: number;
  height: number;
  stride: number;
  originX: number;
  originY: number;
  pixels: Uint8Array;
}

export interface ScreenPixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of a helper frame that shows the display, for the sender to crop
 *  and scale: no pixel is touched in main. */
export interface ScreenHelperPicture {
  /** The frame's rows that cover the display (a view, not a copy): `height`
   *  rows `stride` bytes apart, `width` pixels of B, G, R, X bytes each. */
  pixels: Uint8Array;
  width: number;
  height: number;
  stride: number;
  /** The display's part of those rows, in their pixels. */
  source: ScreenPixelRect;
  /** Where that part lands in the locked `pixelWidth × pixelHeight` picture
   *  (video pixels, fractional when scaled); the rest stays black, never
   *  another display's pixels. */
  target: ScreenPixelRect;
}

/**
 * Locates the display in a helper frame (which may cover the whole virtual
 * screen): the rows to forward, and the source and target rectangles the
 * sender crops and scales with. Only arithmetic: the crop and scale run in
 * the sender renderer. Null when the frame does not cover the display at all.
 */
export function screenFrameRegion(frame: ScreenBgraFrame, mapping: ScreenPointerMapping): ScreenHelperPicture | null {
  if (
    frame.width < 1 ||
    frame.height < 1 ||
    frame.stride < frame.width * 4 ||
    frame.pixels.length < frame.stride * frame.height
  ) {
    throw new Error('remote screen helper frame is malformed');
  }
  const { physical } = mapping;
  const left = Math.max(physical.x, frame.originX);
  const top = Math.max(physical.y, frame.originY);
  const right = Math.min(physical.x + physical.width, frame.originX + frame.width);
  const bottom = Math.min(physical.y + physical.height, frame.originY + frame.height);
  if (right <= left || bottom <= top) return null;
  const firstRow = top - frame.originY;
  const rows = bottom - top;
  const scaleX = mapping.pixelWidth / physical.width;
  const scaleY = mapping.pixelHeight / physical.height;
  return {
    pixels: frame.pixels.subarray(firstRow * frame.stride, (firstRow + rows) * frame.stride),
    width: frame.width,
    height: rows,
    stride: frame.stride,
    source: { x: left - frame.originX, y: 0, width: right - left, height: rows },
    target: {
      x: (left - physical.x) * scaleX,
      y: (top - physical.y) * scaleY,
      width: (right - left) * scaleX,
      height: rows * scaleY,
    },
  };
}
