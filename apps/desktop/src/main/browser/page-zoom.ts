/** Chromium keeps one persisted zoom level per site for the partition, so the
 *  pane's zoom reached hidden agent pages too (a 1280x900 window laid out
 *  3245x2281 CSS px at devicePixelRatio 0.39). */
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
