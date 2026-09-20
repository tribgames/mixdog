/**
 * A fresh full-surface shot of the exact source a frame came from, for
 * zooming: app-owned windows render through Electron, native-backend windows
 * through the worker, everything else through the compositor. Any drift from
 * the frame's geometry is a stale frame, never a silently mis-cropped zoom.
 */
import { desktopCapturer, type NativeImage } from 'electron';

import type { CaptureAttempt } from '../shared/capture-attempts';
import { DESKTOP_CAPTURE_TIMEOUT_MS, OWNED_CAPTURE_TIMEOUT_MS, withTimeout } from '../shared/common';
import type { CaptureFrame, ComputerCommand } from '../shared/types';
import type { createCaptureSources } from './capture-sources';
import type { Rect } from './screenshot-target';
import { electronWindowForNativeId } from './window-handles';

export interface ZoomShot {
  shot: NativeImage;
  sourceId: string;
}

export async function acquireZoomShot(
  sources: ReturnType<typeof createCaptureSources>,
  command: ComputerCommand,
  frame: CaptureFrame,
  base: Rect,
  captureAttempts: CaptureAttempt[]
): Promise<ZoomShot> {
  if (frame.sourceId.startsWith('browser-window:') && frame.windowId) {
    const ownedWindow = electronWindowForNativeId(frame.windowId);
    if (!ownedWindow || ownedWindow.isDestroyed() || ownedWindow.webContents.isDestroyed()) {
      throw new Error(`stale_frame: exact app-owned capture source is unavailable (${frame.id})`);
    }
    const shot = await withTimeout(ownedWindow.capturePage(), OWNED_CAPTURE_TIMEOUT_MS, 'app-owned zoom capture');
    return { shot, sourceId: frame.sourceId };
  }
  if (frame.nativeBackend && frame.windowId) {
    const surface = await sources.nativeWindowSurface(command, frame.windowId, frame.nativeBackend, captureAttempts);
    if (
      surface.bounds.x !== base.x ||
      surface.bounds.y !== base.y ||
      surface.bounds.width !== base.width ||
      surface.bounds.height !== base.height
    ) {
      throw new Error('stale_frame: native capture geometry changed; capture fresh state');
    }
    return { shot: surface.image, sourceId: frame.sourceId };
  }
  const candidates = await withTimeout(
    desktopCapturer.getSources({
      types: [frame.kind],
      thumbnailSize: { width: base.width, height: base.height },
    }),
    DESKTOP_CAPTURE_TIMEOUT_MS,
    'desktop zoom capture'
  );
  const source = candidates.find((candidate) => candidate.id === frame.sourceId);
  if (!source) throw new Error(`stale_frame: exact capture source is unavailable (${frame.id})`);
  return { shot: source.thumbnail, sourceId: source.id };
}
