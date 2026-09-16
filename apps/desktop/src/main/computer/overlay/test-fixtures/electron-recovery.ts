import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createComputerUseOverlay } from '../index';
import { computerUseCoordinator as coordinator } from '../../session/coordinator';
import { nativeOverlayClick } from './native-click';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.OVERLAY_TEST_DIRECTORY!, 'profile'));

const nextWindow = () => new Promise<BrowserWindow>(resolve => {
  app.once('browser-window-created', (_event, window) => resolve(window));
});
const shown = (window: BrowserWindow) => window.isVisible() ? Promise.resolve()
  : new Promise<void>(resolve => window.once('show', () => resolve()));

void app.whenReady().then(async () => {
  const initialWindow = nextWindow();
  let resumed = 0;
  const overlay = createComputerUseOverlay({
    stop: async () => {},
    resume: async () => { resumed++; },
    pause: async () => { coordinator.pauseForUser('user_pause'); },
  }, 'ko');
  try {
    coordinator.beginCommand({ sessionId: 'renderer-hang-fixture', action: 'capture', mode: 'background' });
    const hung = await initialWindow;
    await shown(hung);
    const enteredHang = new Promise<void>(resolve => {
      hung.webContents.on('console-message', (event) => {
        if (event.message === 'OVERLAY_HANG_ENTERED') resolve();
      });
    });
    // Freeze only this fixture's renderer. Dispatch the host unresponsive event
    // explicitly so the test does not depend on Chromium's OS hang-detection delay.
    void hung.webContents.executeJavaScript(
      "console.log('OVERLAY_HANG_ENTERED'); for (;;) {}",
    ).catch(() => { /* Destruction rejects pending script execution. */ });
    await enteredHang;
    const next = nextWindow();
    hung.emit('unresponsive');
    const replacement = await next;
    await shown(replacement);
    assert.equal(hung.isDestroyed(), true);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.equal(resumed, 0);
    assert.equal(replacement.isFocused(), false);

    const point = await replacement.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('dismiss');
      if (button.hidden || button.disabled) throw new Error('replacement Dismiss unavailable');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 4) };
    })()`);
    const [x, y] = replacement.getPosition();
    const handle = replacement.getNativeWindowHandle();
    const hidden = new Promise<void>(resolve => replacement.once('hide', () => resolve()));
    await nativeOverlayClick(
      handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
      screen.dipToScreenPoint({ x: x + point.x, y: y + point.y }),
    );
    await hidden;
    assert.equal(replacement.isVisible(), false);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.throws(() => coordinator.assertAutomationAllowed());
    assert.equal(resumed, 0);
    process.stdout.write(`OVERLAY_RESULT ${JSON.stringify({
      retired: hung.isDestroyed(), visible: replacement.isVisible(),
      inputBlocked: coordinator.snapshot().userControlActive, resumed,
    })}\n`);
  } finally {
    overlay.dispose();
    coordinator.reset();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
