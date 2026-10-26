/**
 * Fixture for page-zoom.electron.test.mjs: real page windows of the Browser
 * Use partition, with the real page preload, on a site whose shared zoom
 * level a narrow pane had left at its fit factor, while the pane's own page
 * of that site keeps that zoom. Prints `PAGE_ZOOM_RESULT <json>`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { app, BrowserWindow, session, type WebContents } from 'electron';

import { BROWSER_PARTITION } from '../command';
import { offscreenWindowOptions } from '../guest-lifecycle';
import { createBrowserNativeViews } from '../native-view';
import { zoomGuest } from '../page-surface-control';
import { createBrowserPageWindow } from '../page-window';
import { createBrowserPartition } from '../partition';

// Inside the test's own directory, which the test removes.
const profile = join(process.env.PAGE_ZOOM_DIRECTORY!, 'profile');
app.setPath('userData', profile);
if (process.env.PAGE_ZOOM_SOFTWARE === '1') app.disableHardwareAcceleration();
// Same Windows occlusion setting as the desktop app (see main/index.ts): a
// parked page stays visible, and keeps its window's place on screen.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/** The level the installed app had persisted for chatgpt.com: a 568 px pane at fit (568 / 1440). */
const FIT = 0.3944;
const PAGE =
  '<!doctype html><html><head><script>window.__early = [innerWidth, innerHeight, devicePixelRatio]</script></head><body>page</body></html>';
const MEASURE = `({
  early: window.__early,
  inner: [innerWidth, innerHeight],
  outer: [outerWidth, outerHeight],
  screen: [screen.width, screen.height],
  dpr: devicePixelRatio,
})`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const measure = (guest: WebContents) => guest.executeJavaScript(MEASURE);
/** The pane's zoom, the way the pane sets it (page-surface-control.ts). */
const paneZoom = (guest: WebContents, factor: number) =>
  zoomGuest(
    { state: { invalidateInteraction() {} } } as unknown as Parameters<typeof zoomGuest>[0],
    { invalidateGeometry() {} },
    guest,
    factor
  );

async function run(): Promise<void> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const site = `http://127.0.0.1:${port}`;
  const otherSite = `http://localhost:${port}`;
  const partition = createBrowserPartition({
    windowSession: session.defaultSession,
    assertResolvedResourceUrlAllowed: async () => {},
    downloadsDirectory: () => profile,
    sessionIdForGuest: () => undefined,
    defaultSessionId: 'default',
  });
  const results: Record<string, unknown> = {};
  // Closed only at the end: a page of the site that dies while the next one
  // starts can take that one's renderer with it.
  const windows: Array<{ destroy(): void }> = [];
  const shell = new BrowserWindow({ show: false });
  windows.push(shell);
  const nativeViews = createBrowserNativeViews({ shell, currentGuest: () => null, humanInput() {} });
  try {
    for (const native of [false, true]) {
      const page = () => {
        const created = createBrowserPageWindow(offscreenWindowOptions(native), native);
        windows.push(created.window);
        // A native page is parked off every display at once, as the host does.
        if (native) nativeViews.watch(created.guest);
        return created;
      };
      // The site's shared level, set the way one persisted before every page
      // kept its own: by a page of the partition with no preload.
      const legacy = new BrowserWindow({
        show: false,
        webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true },
      });
      windows.push(legacy);
      await legacy.loadURL(`${site}/legacy`);
      // The pane's page of the site, zoomed the way the pane zooms it.
      const pane = page();
      await pane.guest.loadURL(`${site}/pane`);
      paneZoom(pane.guest, FIT);
      legacy.webContents.setZoomFactor(FIT);
      const legacyLevel = legacy.webContents.getZoomFactor();
      // A hidden agent page of the same site, and one of a site nobody zoomed.
      const agent = page();
      await agent.guest.loadURL(`${site}/agent`);
      const control = page();
      await control.guest.loadURL(`${otherSite}/control`);
      await pause(300);
      const first = {
        agent: await measure(agent.guest),
        control: await measure(control.guest),
        pane: await measure(pane.guest),
      };
      // The pane's page moves on within the site, and the pane zooms it again.
      await pane.guest.loadURL(`${site}/pane-next`);
      const keptOnNavigation = pane.guest.getZoomFactor();
      paneZoom(pane.guest, 0.5);
      await agent.guest.loadURL(`${site}/agent-next`);
      await pause(300);
      results[native ? 'native' : 'offscreen'] = {
        legacyLevel,
        siteLevelAfter: legacy.webContents.getZoomFactor(),
        content: agent.window.getContentSize(),
        keptOnNavigation,
        first,
        next: { agent: await measure(agent.guest), pane: await measure(pane.guest) },
      };
    }
  } finally {
    for (const window of windows) window.destroy();
    partition.dispose();
    server.close();
  }
  console.log(`PAGE_ZOOM_RESULT ${JSON.stringify(results)}`);
}

void app
  .whenReady()
  .then(run)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
