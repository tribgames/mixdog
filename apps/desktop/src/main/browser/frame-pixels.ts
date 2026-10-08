/** The pixel size Chromium composites a page window at; every display frame of
 *  that window (paint image, shared texture, capturePage) has exactly this
 *  size. An offscreen view is sized by the window's outer bounds at the primary
 *  display's scale (Electron's OSR view resolves the display of its null native
 *  view); a native window by its client area at its own display's scale.
 *  Chromium scales in float32 and rounds up (gfx::ScaleToCeiledSize), except
 *  that an offscreen view without hardware acceleration paints its own
 *  compositor output, which it sizes rounding down (ResizeRootLayer). */
import type { BrowserWindow, Screen } from 'electron';

export function browserFramePixels(
  owner: Pick<BrowserWindow, 'getBounds' | 'getContentBounds'>,
  offscreen: boolean,
  hardwareAccelerated: boolean,
  screen: Pick<Screen, 'getPrimaryDisplay' | 'getDisplayMatching'>
): { width: number; height: number } {
  const box = offscreen ? owner.getBounds() : owner.getContentBounds();
  const scale = (offscreen ? screen.getPrimaryDisplay() : screen.getDisplayMatching(owner.getBounds())).scaleFactor;
  const round = offscreen && !hardwareAccelerated ? Math.floor : Math.ceil;
  return {
    width: round(Math.fround(box.width * scale)),
    height: round(Math.fround(box.height * scale)),
  };
}
