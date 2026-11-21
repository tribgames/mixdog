import type { WebFrameMain } from 'electron';

import { visualizeOverlayScript } from './overlay-script';

/** A cascade layer: any unlayered rule of the page beats a layered one
 *  whatever its specificity or order. */
const PANE_SCROLLBAR_CSS = `@layer mixdog-scrollbar {
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    border: 2px solid transparent;
    border-radius: 999px;
    background: rgba(128, 128, 128, 0.5);
    background-clip: padding-box;
  }
  *::-webkit-scrollbar-thumb:hover {
    background: rgba(128, 128, 128, 0.75);
    background-clip: padding-box;
  }
  *::-webkit-scrollbar-corner { background: transparent; }
}`;

/** Adopts the stylesheet instead of inserting a `<style>`: a constructed
 *  stylesheet is not subject to the page's own `style-src` CSP, and it adds
 *  no DOM node or console output to the page. */
export const PANE_SCROLLBAR_SCRIPT = `(() => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(PANE_SCROLLBAR_CSS)});
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
})()`;

type PaneFrameSource = {
  isPaneFrame(url: string): boolean;
  marksForFrame(url: string): Array<{ selector: string; label: string }>;
};

/** A frame of the main window loaded: when it is a pane page, style its
 *  scrollbars and redraw the tab's marks (the overlay lives on the page's window). */
export async function preparePaneFrame(frame: WebFrameMain, source: PaneFrameSource): Promise<void> {
  if (frame.isDestroyed() || !source.isPaneFrame(frame.url)) return;
  const marks = source.marksForFrame(frame.url);
  await Promise.all([
    frame.executeJavaScript(PANE_SCROLLBAR_SCRIPT).catch(() => undefined),
    marks.length ? frame.executeJavaScript(visualizeOverlayScript(marks)).catch(() => undefined) : undefined,
  ]);
}
