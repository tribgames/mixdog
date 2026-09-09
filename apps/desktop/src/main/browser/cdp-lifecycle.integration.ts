import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app, BrowserWindow } from 'electron';
import { createBrowserGuestCdp } from './cdp';
import { BrowserGuestStateStore } from './guest-state';

// This process owns only disposable windows/profile; never attach to the live app.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mixdog-cdp-lifecycle-')));
app.commandLine.appendSwitch('site-per-process');
const server = createServer((req, res) => {
  if (req.url === '/slow') {
    const timer = setTimeout(() => res.end('<p>slow frame</p>'), 250);
    res.once('close', () => clearTimeout(timer));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  const port = (server.address() as { port: number }).port;
  res.end(req.url === '/frame'
    ? `<iframe src="http://127.0.0.1:${port}/slow"></iframe>`
    : `<h1>navigation</h1><iframe src="http://localhost:${port}/frame"></iframe>`);
});
async function run() {
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const state = new BrowserGuestStateStore();
  const cdp = createBrowserGuestCdp({
    state, interceptFetchPatterns: () => [], matchInterceptRule: () => undefined,
  });
  let observedFrame = false;
  for (let iteration = 0; iteration < 12; iteration++) {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const guest = window.webContents;
    await cdp.guestDebugger(guest);
    await guest.loadURL(`http://127.0.0.1:${port}/?iteration=${iteration}`);
    for (let tries = 0; tries < 40 && state.for(guest).cdpSessions.size === 0; tries++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    observedFrame ||= state.for(guest).cdpSessions.size > 0;
    assert.equal(await cdp.evaluate(guest, 'document.querySelector("h1").textContent'), 'navigation');
    // Start frame navigation, then immediately detach or close the owning tab.
    await cdp.evaluate(guest, `document.querySelector('iframe').src = 'http://localhost:${port}/slow'`);
    const navigation = guest.loadURL(`http://127.0.0.1:${port}/?next=${iteration}`).catch(() => undefined);
    if (iteration % 2 === 0) {
      await cdp.detach(guest);
      await navigation;
      await cdp.guestDebugger(guest);
      assert.equal(await cdp.evaluate(guest, 'document.querySelector("h1").textContent'), 'navigation');
      await cdp.detach(guest);
      assert.equal(state.for(guest).cdpSessions.size, 0);
    }
    window.destroy();
    await navigation;
  }
  assert.ok(observedFrame, 'exercise a real out-of-process iframe');
  const message = 'CDP lifecycle integration passed (12 navigation/detach/tab-close cycles)\n';
  if (process.env.MIXDOG_BROWSER_INTEGRATION_LOG) appendFileSync(process.env.MIXDOG_BROWSER_INTEGRATION_LOG, message);
  console.log(message);
}
app.on('window-all-closed', () => { /* Keep the isolated test process alive between cycles. */ });
run().then(() => {
  server.close();
  app.exit(0);
}, error => {
  console.error(error);
  server.close();
  app.exit(1);
});
