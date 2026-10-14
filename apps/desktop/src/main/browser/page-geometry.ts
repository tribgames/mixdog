/**
 * Resizing a page's own window and reading its current geometry, for the
 * page surface's display capture.
 */
import type { WebContents } from 'electron';
import { screen } from 'electron';
import { browserFramePixels } from './frame-pixels';
import { browserPageWindow } from './page-window';

export function browserPageGeometry(sharedTextureRendering: boolean) {
  return {
    resize: (guest: WebContents, width: number, height: number) => {
      const owner = browserPageWindow(guest);
      if (!owner) return null;
      owner.setContentSize(width, height);
      const [landedWidth, landedHeight] = owner.getContentSize();
      return { width: landedWidth, height: landedHeight };
    },
    viewport: (guest: WebContents) => {
      const owner = browserPageWindow(guest);
      if (!owner || guest.isDestroyed()) {
        throw new Error('Browser page changed during capture.');
      }
      const [width, height] = owner.getContentSize();
      const pixels = browserFramePixels(owner, guest.isOffscreen(), sharedTextureRendering, screen);
      return { width, height, zoom: guest.getZoomFactor(), pixels };
    },
  };
}
