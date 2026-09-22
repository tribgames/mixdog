/**
 * Failure diagnostics for the local browser surface: what every live page,
 * the fixture shell and the guest looked like when the lane threw. Each read
 * is bounded so a hung renderer cannot replace the original failure.
 */
import { BrowserWindow, webContents, type WebContents } from 'electron';

async function bounded<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function logBrowserSurfaceDiagnostics(
  shell: WebContents,
  guest: WebContents,
  log: (text: string) => void
): Promise<void> {
  for (const page of webContents.getAllWebContents().filter((page) => page !== shell)) {
    try {
      log(
        JSON.stringify({
          page: page.id,
          url: page.getURL(),
          offscreen: page.isOffscreen(),
          painting: page.isOffscreen() ? page.isPainting() : null,
          bounds: BrowserWindow.fromWebContents(page)?.getBounds(),
          document: await bounded(
            page.executeJavaScript(`({
          ready: document.readyState, visibility: document.visibilityState,
          width: innerWidth, height: innerHeight, focused: document.hasFocus(),
        })`)
          ),
        })
      );
    } catch {
      log('page destroyed while collecting diagnostics');
    }
  }
  log(
    JSON.stringify(
      await bounded(
        shell.executeJavaScript(`({
      active: document.activeElement?.className,
      image: (() => { const image = document.querySelector('.browser-isolated-pixels > :first-child');
        return image ? {width:image.naturalWidth || image.width,height:image.naturalHeight || image.height,box:image.getBoundingClientRect().toJSON()} : null; })(),
      notices: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent),
    })`)
      )
    )
  );
  log(
    JSON.stringify(
      guest.isDestroyed()
        ? { destroyed: true }
        : await bounded(
            guest.executeJavaScript(`({
      focused: document.activeElement?.id,
      text: document.getElementById('agent')?.value,
      keys: window.keys,
    })`)
          )
    )
  );
}
