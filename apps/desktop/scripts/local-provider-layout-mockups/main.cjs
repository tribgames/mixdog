const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const output = process.argv[2];
mkdirSync(join(output, 'profile'), { recursive: true });
app.setPath('userData', join(output, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width: 1396,
    height: 900,
    useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(join(output, 'index.html'));
    const variants = await evaluate('window.layoutMockups.variants');
    const shots = [];
    for (const theme of ['dark', 'light']) {
      for (const variant of variants) {
        await evaluate(`window.layoutMockups.render(${JSON.stringify(variant)}, ${JSON.stringify(theme)})`);
        // Capture the dialog itself, not the empty window around it.
        const rect = await evaluate(`(() => {
          const r = document.querySelector('[role="dialog"]').getBoundingClientRect();
          return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
        })()`);
        win.webContents.invalidate();
        await evaluate('window.layoutMockups.settle()');
        const file = `${variant}-${theme}.png`;
        writeFileSync(join(output, file), (await win.webContents.capturePage(rect)).toPNG());
        shots.push(file);
      }
    }
    console.log(JSON.stringify({ output, shots }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
