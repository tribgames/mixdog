// Hidden, isolated Chromium diagnostic. No live page or OS input is touched.
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const root = mkdtempSync(join(tmpdir(), 'mixdog-mouse-probe-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const deadline = setTimeout(() => { console.error('Mouse probe timed out'); app.exit(1); }, 15000);
  const window = new BrowserWindow({ show: false, focusable: false, width: 1280, height: 720,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const server = createServer((_request, response) => response.end('<main style="height:1000px">Mouse timing</main>'));
  try {
    const guest = window.webContents;
    await guest.loadURL('about:blank');
    guest.debugger.attach('1.3');
    await guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await guest.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await Promise.all(['Page', 'Runtime', 'Network', 'Log', 'Accessibility']
      .map(domain => guest.debugger.sendCommand(`${domain}.enable`)));
    guest.setZoomFactor(0.75);
    await guest.executeJavaScript(`window.addEventListener('mousemove', e => {
      window.lastMove = { at: Date.now(), trusted: e.isTrusted, x: e.clientX, y: e.clientY };
      window.resolveMove?.(window.lastMove);
    }, true)`);
    const samples = [];
    for (const mode of ['cdp', 'native', 'cdp', 'native']) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const x = 100 + samples.length * 30;
      await guest.executeJavaScript('window.movePromise = new Promise(r => { window.resolveMove = r }); void 0');
      const started = Date.now();
      let event;
      if (mode === 'cdp') {
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y: 100, button: 'none', clickCount: 1, modifiers: 0,
        });
        event = await guest.executeJavaScript('window.lastMove');
      } else {
        guest.sendInputEvent({ type: 'mouseMove', x, y: 100 });
        event = await Promise.race([
          guest.executeJavaScript('window.movePromise'),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('native move was not delivered')), 2000);
            timer.unref();
          }),
        ]);
      }
      if (!event?.trusted || event.at < started) throw new Error('Movement delivery was not verified');
      samples.push({ mode, ackMs: Date.now() - started, eventMs: event.at - started, x, deliveredX: event.x });
    }
    console.log(JSON.stringify(samples));
  } finally {
    clearTimeout(deadline);
    server.close();
    window.destroy();
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
app.on('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
