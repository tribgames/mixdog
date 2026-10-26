/**
 * The geometry main locks for a streamed page: its CSS viewport as it is
 * (never refitted to the phone unless the phone explicitly asks), and the
 * capture pixel size, which honours the page's device pixel ratio up to the
 * client's frame bound. Renewals, keyboard and rotation never change it; only
 * a real change of the page (a PC-side resize or zoom, or an explicit resize)
 * locks a new generation.
 */
import type { DesktopRemoteBrowserStreamOptions } from '../../shared/contract';
import type { RemoteWebrtcGeometry } from '../../shared/remote-webrtc';
import type { BrowserGuestCdp } from './cdp';

/** What the page lays out at, from Page.getLayoutMetrics. */
export interface RemotePageMetrics {
  cssWidth: number;
  cssHeight: number;
  /** Device pixels per CSS pixel: display scale × zoom, or the emulated one. */
  devicePixelRatio: number;
}

/**
 * How frames are captured at the locked size:
 * - `screencast`: Page.startScreencast frames, which Chromium sizes in DIP
 *   (CSS pixels) and only ever scales down — exact when the pixel size is at
 *   most the CSS size.
 * - `screenshot`: Page.captureScreenshot of the viewport, at the page's device
 *   pixels — used when those exceed the CSS size and fit the client's bound.
 *   The screencast keeps running as the page's repaint signal.
 */
export type RemoteCaptureMode = 'screencast' | 'screenshot';

export interface RemoteLockedGeometry {
  geometry: RemoteWebrtcGeometry;
  capture: RemoteCaptureMode;
  /** Changes exactly when the capture must restart. */
  key: string;
}

const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

/** Lock `metrics` as generation `generation`, within the client's frame bound. */
export function lockRemoteGeometry(
  metrics: RemotePageMetrics,
  bound: DesktopRemoteBrowserStreamOptions,
  generation: number
): RemoteLockedGeometry {
  const cssWidth = Math.max(1, Math.round(metrics.cssWidth));
  const cssHeight = Math.max(1, Math.round(metrics.cssHeight));
  const ratio = metrics.devicePixelRatio > 0 ? metrics.devicePixelRatio : 1;
  const nativeWidth = cssWidth * ratio;
  const nativeHeight = cssHeight * ratio;
  const screenshot =
    ratio > 1 && evenFloor(nativeWidth) <= bound.maxWidth && evenFloor(nativeHeight) <= bound.maxHeight;
  let pixelWidth: number;
  let pixelHeight: number;
  if (screenshot) {
    pixelWidth = evenFloor(nativeWidth);
    pixelHeight = evenFloor(nativeHeight);
  } else {
    const scale = Math.min(1, bound.maxWidth / cssWidth, bound.maxHeight / cssHeight);
    pixelWidth = evenFloor(cssWidth * scale);
    pixelHeight = evenFloor(cssHeight * scale);
  }
  const capture: RemoteCaptureMode = screenshot ? 'screenshot' : 'screencast';
  return {
    geometry: { generation, cssWidth, cssHeight, deviceScaleFactor: ratio, pixelWidth, pixelHeight },
    capture,
    key: `${cssWidth}x${cssHeight}@${ratio}:${pixelWidth}x${pixelHeight}:${capture}`,
  };
}

/** Whether the page still lays out as `locked` describes. */
export function remoteGeometryHolds(locked: RemoteLockedGeometry, metrics: RemotePageMetrics): boolean {
  const { geometry } = locked;
  return (
    Math.round(metrics.cssWidth) === geometry.cssWidth &&
    Math.round(metrics.cssHeight) === geometry.cssHeight &&
    metrics.devicePixelRatio === geometry.deviceScaleFactor
  );
}

/** The page's device pixel ratio from its layout metrics: the deprecated
 *  `visualViewport` is in device pixels, `cssVisualViewport` in CSS pixels
 *  (both exclude scrollbars, so their ratio is exact). Null when unreadable,
 *  e.g. while a dialog holds the page. The CSS size itself comes from the
 *  screencast's own metadata, which covers the whole view frames show. */
export async function readRemotePagePixelRatio(
  cdp: Pick<BrowserGuestCdp, 'call'>,
  guest: Electron.WebContents
): Promise<number | null> {
  const metrics = await cdp.call<{
    cssVisualViewport?: { clientWidth: number };
    visualViewport?: { clientWidth: number };
  }>(guest, 'Page.getLayoutMetrics');
  const css = metrics.cssVisualViewport?.clientWidth;
  const device = metrics.visualViewport?.clientWidth;
  if (!css || !device || css <= 0 || device <= 0) return null;
  // Rounded to the thousandth, as the drive viewport rounds its scale.
  return Math.round((device / css) * 1_000) / 1_000;
}
