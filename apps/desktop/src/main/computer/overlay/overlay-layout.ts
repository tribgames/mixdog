/**
 * Where the pills sit on a display, with no Electron in sight. The Computer
 * Use pill owns the top-centre slot; the remote-screen pill takes the slot
 * directly below it, never the same one.
 */
import { OVERLAY_HEIGHT, OVERLAY_PILL_HEIGHT, OVERLAY_PILL_INSET, OVERLAY_WIDTH } from './content';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Space between the Computer Use pill and the remote pill below it. */
export const REMOTE_PILL_GAP = 8;
/** The click-catching area around a pill, so its shadow edge still responds. */
const SHAPE_MARGIN = 4;

/** The top-centre slot of a display's work area. */
export function overlayBounds(display: { workArea: Rect }): Rect {
  return {
    x: Math.round(display.workArea.x + (display.workArea.width - OVERLAY_WIDTH) / 2),
    y: display.workArea.y + 6,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  };
}

export type RemotePillSlot = 'top' | 'below';

/** Same centre line as the top slot; `below` drops by one pill and the gap, so
 *  the pills (not their transparent windows) are exactly `REMOTE_PILL_GAP` apart. */
export function remoteOverlayBounds(display: { workArea: Rect }, slot: RemotePillSlot): Rect {
  const top = overlayBounds(display);
  return slot === 'top' ? top : { ...top, y: top.y + OVERLAY_PILL_HEIGHT + REMOTE_PILL_GAP };
}

/** The slot rule. The remote pill takes the top slot only while the Computer
 *  Use pill is absent; once it has dropped below it never climbs back, so
 *  nothing moves under a click when Computer Use ends. */
export function nextRemoteSlot(current: RemotePillSlot, computerPillShown: boolean): RemotePillSlot {
  return current === 'below' || computerPillShown ? 'below' : 'top';
}

export function boundsKey(bounds: Rect): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

/** Everything outside the pill is click-through. Where shapes are unsupported
 *  (macOS, test doubles) the window keeps its plain rectangle. */
export function clipWindowToPill(window: { setShape?: (rects: Rect[]) => void }): void {
  window.setShape?.([
    {
      x: OVERLAY_PILL_INSET - SHAPE_MARGIN,
      y: OVERLAY_PILL_INSET - SHAPE_MARGIN,
      width: OVERLAY_WIDTH - 2 * (OVERLAY_PILL_INSET - SHAPE_MARGIN),
      height: OVERLAY_PILL_HEIGHT + 2 * SHAPE_MARGIN,
    },
  ]);
}
