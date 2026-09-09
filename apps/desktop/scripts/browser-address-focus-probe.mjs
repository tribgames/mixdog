import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Run with Electron; DOM emulators do not implement Chromium's focus cascade.
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
try {
  await window.loadURL('data:text/html,<!doctype html><html><head></head><body><input class="browser-pane-address"><button>Next</button></body></html>');
  const css = [
    ':root { --mx-focus: #888888; --mx-border-muted: #444444; }',
    ...['02-base.css', '32-browser-pane.css'].map(file =>
      readFileSync(new URL(`../src/renderer/desktop/${file}`, import.meta.url), 'utf8')),
  ].join('\n');
  await window.webContents.insertCSS(css);
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const result = await window.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('input');
    const read = () => {
      const style = getComputedStyle(document.activeElement);
      return { outline: style.outlineStyle, width: style.outlineWidth,
        border: style.borderColor, focused: document.activeElement === field };
    };
    document.documentElement.dataset.mxInput = 'pointer';
    field.focus();
    const pointer = read();
    document.documentElement.dataset.mxInput = 'keyboard';
    const keyboard = read();
    document.querySelector('button').focus();
    return { pointer, keyboard, button: read() };
  })()`);
  assert.equal(result.pointer.outline, 'none');
  assert.equal(result.pointer.border, 'rgb(68, 68, 68)');
  assert.equal(result.pointer.focused, true);
  assert.equal(result.keyboard.outline, 'solid');
  assert.equal(result.keyboard.width, '1px');
  assert.equal(result.keyboard.border, 'rgb(136, 136, 136)');
  assert.equal(result.button.outline, 'solid');
  console.log('PASS: Chromium pointer focus is quiet; keyboard focus rings remain.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  window.destroy();
  app.exit(process.exitCode || 0);
}
}).catch(error => {
  console.error(error);
  app.exit(1);
});
