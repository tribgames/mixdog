/** Isolated compatibility probe: never opens a user's page or input window. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, sharedTexture } from 'electron';

const directory = process.env.MIXDOG_TEXTURE_DIRECTORY!;
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => {
  console.error('Shared texture probe timed out.');
  app.exit(1);
}, 20000);
async function run(): Promise<void> {
  console.log('Texture probe GPU devices:', JSON.stringify(await app.getGPUInfo('complete')));
  console.log('Texture probe GPU:', JSON.stringify(app.getGPUFeatureStatus()));
  const target = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(directory, 'preload.cjs'),
    },
  });
  const source = new BrowserWindow({
    show: false,
    focusable: false,
    width: 320,
    height: 240,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: { useSharedTexture: true },
    },
  });
  try {
    const ready = new Promise<void>((resolve) => ipcMain.once('texture-ready', () => resolve()));
    await target.loadURL('data:text/html,<canvas></canvas>');
    await ready;
    const rendered = new Promise<void>((resolve, reject) => {
      let sent = false;
      ipcMain.on('texture-pixels', (_event, pixels) => {
        console.log('Shared texture pixel:', pixels);
        if (pixels[0] === 31 && pixels[1] === 80 && pixels[2] === 100 && pixels[3] === 255) resolve();
      });
      source.webContents.on('paint', (event) => {
        const texture = event.texture;
        if (!texture) {
          reject(new Error('GPU paint did not supply a shared texture.'));
          return;
        }
        if (sent) {
          texture.release();
          return;
        }
        sent = true;
        const imported = sharedTexture.importSharedTexture({
          textureInfo: texture.textureInfo,
          allReferencesReleased: () => texture.release(),
        });
        void sharedTexture
          .sendSharedTexture({
            frame: target.webContents.mainFrame,
            importedSharedTexture: imported,
          })
          .then(() => {
            sent = false;
          }, reject)
          .finally(() => imported.release());
      });
    });
    await source.loadURL('data:text/html,<style>html{background:rgb(31,80,100)}</style>');
    await rendered;
    source.webContents.debugger.attach('1.3');
    const screenshot = await source.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    assert.ok(screenshot.data.length > 0, 'agent screenshots must remain available');
    assert.equal(source.isVisible(), false);
    assert.equal(source.isFocusable(), false);
    console.log('Shared texture transfer, exact pixels, screenshots and hidden ownership passed.');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
}
void app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
