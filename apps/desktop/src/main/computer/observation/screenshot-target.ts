/**
 * The surface a screenshot is about — one exact window, or one display — and
 * the physical-pixel geometry the caption maps image coordinates back to, so
 * a click x/y read off the image lands on the screen.
 */
import { screen } from 'electron';

import {
  DEFAULT_SCREENSHOT_MAX_WIDTH,
  DEFAULT_SCREENSHOT_QUALITY,
  MAX_SCREENSHOT_MAX_WIDTH,
  MIN_SCREENSHOT_MAX_WIDTH,
} from '../shared/common';
import type { ComputerCommand } from '../shared/types';
import { screenshotInteger } from './analysis';
import type { CaptureEngineHost } from './capture';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotTarget {
  sourceType: 'screen' | 'window';
  sourceTitle: string;
  /** Logical size of the source; the fallback denominator for quality checks. */
  sourceWidth: number;
  sourceHeight: number;
  displayId: string;
  windowId: string;
  /** Physical-pixel origin and size of the surface to capture. */
  geometry: Rect;
  /** The named window's own outer bounds, kept even when the captured
   *  surface turns out to be a different rectangle. */
  targetWindow: Rect;
  ownerWindowId: string;
  client: Rect;
  relatedWindowIds: string[] | null;
}

export interface ScreenshotEncoding {
  quality: number;
  maxWidth: number;
}

const zeroRect = (): Rect => ({ x: 0, y: 0, width: 0, height: 0 });

export function screenshotEncoding(command: ComputerCommand): ScreenshotEncoding {
  return {
    quality: screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality'),
    maxWidth: screenshotInteger(
      command.maxWidth,
      DEFAULT_SCREENSHOT_MAX_WIDTH,
      MIN_SCREENSHOT_MAX_WIDTH,
      MAX_SCREENSHOT_MAX_WIDTH,
      'maxWidth'
    ),
  };
}

export function targetsWindow(command: ComputerCommand): boolean {
  return Boolean(command.window_id?.trim() || command.window?.trim());
}

/** The named window's bounds from the native side; `includeWindow` widens the
 *  observation to the exact id before the bounds are judged. */
export async function windowScreenshotTarget(
  host: Pick<CaptureEngineHost, 'callPowerShell' | 'sessionIdFor'>,
  command: ComputerCommand,
  includeWindow: (windowId: string) => void
): Promise<ScreenshotTarget> {
  const bounds = await host.callPowerShell({
    action: 'window_bounds',
    window: command.window?.trim() || null,
    window_id: command.window_id?.trim() || null,
    session_id: host.sessionIdFor(command),
    read_only: true,
  });
  if (!bounds.ok) throw new Error(bounds.error || 'window bounds lookup failed');
  const sourceTitle = String(bounds.result?.title || command.window?.trim() || command.window_id);
  const windowId = String(bounds.result?.window_id || command.window_id || '');
  includeWindow(windowId);
  const sourceWidth = Number(bounds.result?.width);
  const sourceHeight = Number(bounds.result?.height);
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    throw new Error(`window has no capturable bounds: ${sourceTitle}`);
  }
  const originX = Math.round(Number(bounds.result?.x) || 0);
  const originY = Math.round(Number(bounds.result?.y) || 0);
  const geometry = { x: originX, y: originY, width: sourceWidth, height: sourceHeight };
  const ids = Array.isArray(bounds.result?.related_window_ids)
    ? bounds.result.related_window_ids.map(String).filter(Boolean)
    : [];
  return {
    sourceType: 'window',
    sourceTitle,
    sourceWidth,
    sourceHeight,
    displayId: '',
    windowId,
    geometry,
    targetWindow: { ...geometry },
    ownerWindowId: String(bounds.result?.owner_id || ''),
    client: {
      x: Math.round(Number(bounds.result?.client_x ?? originX)),
      y: Math.round(Number(bounds.result?.client_y ?? originY)),
      width: Math.round(Number(bounds.result?.client_width) || 0),
      height: Math.round(Number(bounds.result?.client_height) || 0),
    },
    relatedWindowIds: ids.includes(windowId) ? ids : [windowId, ...ids],
  };
}

/** The requested display (primary by default) in physical pixels. */
export function displayScreenshotTarget(command: ComputerCommand): ScreenshotTarget {
  const displays = screen.getAllDisplays();
  const primaryIndex = Math.max(
    0,
    displays.findIndex((display) => display.id === screen.getPrimaryDisplay().id)
  );
  const index = screenshotInteger(command.screen, primaryIndex, 0, Math.max(0, displays.length - 1), 'screen');
  const display = displays[index] ?? screen.getPrimaryDisplay();
  const nativeOrigin = display.nativeOrigin ?? { x: display.bounds.x, y: display.bounds.y };
  return {
    sourceType: 'screen',
    sourceTitle: displays.length > 1 ? `screen ${index + 1}/${displays.length}` : 'primary screen',
    sourceWidth: display.size.width,
    sourceHeight: display.size.height,
    displayId: String(display.id),
    windowId: '',
    geometry: {
      x: nativeOrigin.x,
      y: nativeOrigin.y,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
    targetWindow: zeroRect(),
    ownerWindowId: '',
    client: zeroRect(),
    relatedWindowIds: null,
  };
}

/** Where the captured pixels actually are. A surface that reports its own
 *  bounds wins outright; a composited window thumbnail is matched by aspect
 *  ratio to either the outer window or its client area — whichever the
 *  compositor really drew — so click coordinates map onto the right box. */
export function capturedGeometry(
  target: ScreenshotTarget,
  surface: { bounds?: Rect; nativeBackend?: unknown },
  captureSize: { width: number; height: number }
): Rect {
  let geometry: Rect = surface.bounds ? { ...surface.bounds } : { ...target.geometry };
  if (target.windowId && !surface.nativeBackend && target.client.width > 0 && target.client.height > 0) {
    const actualAspectRatio = captureSize.width / Math.max(1, captureSize.height);
    geometry = [geometry, target.client].reduce((best, candidate) => {
      const candidateRatio = candidate.width / Math.max(1, candidate.height);
      const candidateError = Math.abs(candidateRatio - actualAspectRatio) / Math.max(0.0001, candidateRatio);
      const bestRatio = best.width / Math.max(1, best.height);
      const bestError = Math.abs(bestRatio - actualAspectRatio) / Math.max(0.0001, bestRatio);
      return candidateError < bestError ? candidate : best;
    });
  }
  return { ...geometry };
}
