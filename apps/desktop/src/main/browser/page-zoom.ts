/**
 * Every Browser Use page keeps a zoom of its own. Chromium keeps one zoom
 * level per site for the whole partition, persists it, and applies it to
 * every page of that site, so the pane's zoom (the fit factor of a narrow
 * pane, or the user's own) reached every page of the site, hidden agent pages
 * included: a 1280x900 page window then laid out 3245x2281 CSS px at a
 * devicePixelRatio of 0.39 — inner larger than outer and than the screen, a
 * state sites read as automation.
 *
 * The page preload (preload/browser-page.ts) asks at each document start,
 * once the document is committed. The answer sets the site's shared level
 * back to 100% (which also clears a level persisted before this) and names the
 * page's own zoom: the one last set on that page, else 100%. The preload makes
 * it the page's own level (Chromium's temporary zoom level), and from then on
 * a zoom set on the page changes that page alone.
 */
import type { IpcMain, IpcMainEvent, Session, WebContents } from 'electron';

/** The preload's question; preload/browser-page.ts names it too. */
export const BROWSER_PAGE_ZOOM_CHANNEL = 'mixdog-browser-page-zoom';

const ownZooms = new WeakMap<WebContents, number>();

/** Sets a page's zoom (the pane's, a restored page's): it holds for that page
 *  alone, and for its next documents too. */
export function setBrowserPageZoom(page: WebContents, factor: number): void {
  ownZooms.set(page, factor);
  page.setZoomFactor(factor);
}

/** The zoom a page starts its document with. Only a page of `partition`
 *  resets the site's shared level; any other asker keeps its zoom. */
export function browserPageZoomAtDocumentStart(page: WebContents, partition: Session): number {
  if (page.session !== partition) return page.getZoomFactor();
  // The new document has no level of its own yet: this sets the site's.
  page.setZoomFactor(1);
  return ownZooms.get(page) ?? 1;
}

/** Answers the preload of every page of `partition`; returns the uninstall. */
export function installBrowserPageZoom(ipc: Pick<IpcMain, 'on' | 'removeListener'>, partition: Session): () => void {
  const answer = (event: IpcMainEvent) => {
    event.returnValue = browserPageZoomAtDocumentStart(event.sender, partition);
  };
  ipc.on(BROWSER_PAGE_ZOOM_CHANNEL, answer);
  return () => {
    ipc.removeListener(BROWSER_PAGE_ZOOM_CHANNEL, answer);
  };
}
