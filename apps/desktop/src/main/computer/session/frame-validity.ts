/**
 * Whether the surface a frame was captured from is still where the frame
 * says: a window that moved or resized, or a display whose layout changed,
 * makes every pixel coordinate in that frame point somewhere else.
 */
import { screen } from 'electron';

import type { CaptureFrame } from '../shared/types';
import type { SessionStateHost } from './state';

async function assertWindowUnchanged(host: SessionStateHost, frame: CaptureFrame): Promise<void> {
  const bounds = await host.callPowerShell({
    action: 'window_bounds',
    window_id: frame.windowId,
    session_id: frame.sessionId,
    read_only: true,
  });
  if (!bounds.ok) throw new Error(`stale_frame: target window is gone (${frame.windowId})`);
  const same =
    Number(bounds.result?.x) === (frame.targetWindowX ?? frame.windowX) &&
    Number(bounds.result?.y) === (frame.targetWindowY ?? frame.windowY) &&
    Number(bounds.result?.width) === (frame.targetWindowWidth ?? frame.windowWidth) &&
    Number(bounds.result?.height) === (frame.targetWindowHeight ?? frame.windowHeight);
  if (!same) throw new Error(`stale_frame: target window moved or resized (${frame.id})`);
}

function assertDisplayUnchanged(frame: CaptureFrame): void {
  const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === frame.displayId);
  const origin = display?.nativeOrigin ?? (display ? { x: display.bounds.x, y: display.bounds.y } : null);
  const same =
    !!display &&
    !!origin &&
    origin.x === frame.displayX &&
    origin.y === frame.displayY &&
    Math.round(display.size.width * display.scaleFactor) === frame.displayWidth &&
    Math.round(display.size.height * display.scaleFactor) === frame.displayHeight;
  if (!same) throw new Error(`stale_frame: display layout changed (${frame.id})`);
}

export async function assertFrameSurfaceUnchanged(host: SessionStateHost, frame: CaptureFrame): Promise<void> {
  if (frame.kind === 'window') await assertWindowUnchanged(host, frame);
  else assertDisplayUnchanged(frame);
}
