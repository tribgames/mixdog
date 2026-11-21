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

/** `screencast` frames are sized by Chromium in CSS pixels and only scaled down; `screenshot` captures at device pixels. */
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

/** `visualViewport` is in device pixels, `cssVisualViewport` in CSS pixels, both without scrollbars. Null when unreadable. */
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
