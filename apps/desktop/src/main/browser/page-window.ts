/** Every page lives in a window of its own that the shell never shows. With
 *  native presentation that window hosts the page in a view the shell can
 *  adopt while the Browser pane shows it (see native-view): one window then
 *  composes the shell and the page together. This registry answers which
 *  window owns a page; Electron's own lookup names the shell while the page
 *  is adopted. */
import { BaseWindow, BrowserWindow, WebContentsView, type WebContents } from 'electron';

interface PageHost {
  window: BaseWindow;
  view: WebContentsView | null;
}

const hosts = new WeakMap<WebContents, PageHost>();

/** Register a page window Electron created itself (an offscreen page's popup). */
export function adoptBrowserPageWindow(window: BrowserWindow): BaseWindow {
  hosts.set(window.webContents, { window, view: null });
  return window;
}

/** A new page and its window. A hosted page is a view inside a frameless
 *  window, sized to fill it whenever the window holds it; `webContents` hosts
 *  a page Chromium already created (a popup). */
export function createBrowserPageWindow(
  options: Electron.BrowserWindowConstructorOptions,
  hosted = false,
  webContents?: WebContents
): { window: BaseWindow; guest: WebContents } {
  if (!hosted) {
    const window = new BrowserWindow(options);
    return { window: adoptBrowserPageWindow(window), guest: window.webContents };
  }
  const { webPreferences, ...windowOptions } = options;
  const window = new BaseWindow(windowOptions);
  const view = new WebContentsView(webContents ? { webContents } : { webPreferences });
  const guest = view.webContents;
  // While a resized page has not yet drawn at its new size, the uncovered
  // strip shows this colour instead of the shell beneath: a page's default.
  view.setBackgroundColor('#ffffff');
  window.contentView.addChildView(view);
  const fit = () => {
    if (window.isDestroyed() || !window.contentView.children.includes(view)) return;
    const [width, height] = window.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  window.on('resize', fit);
  hosts.set(guest, { window, view });
  // Neither outlives the other: a page that closes itself takes its window,
  // and a destroyed window its page.
  guest.once('destroyed', () => {
    if (!window.isDestroyed()) window.destroy();
  });
  window.once('closed', () => {
    if (!guest.isDestroyed()) guest.close();
  });
  return { window, guest };
}

export function browserPageWindow(guest: WebContents): BaseWindow | null {
  const window = hosts.get(guest)?.window;
  return window && !window.isDestroyed() ? window : null;
}

/** The view a hosted page draws in; null for a page that is its window. */
export function browserPageView(guest: WebContents): WebContentsView | null {
  return hosts.get(guest)?.view ?? null;
}
