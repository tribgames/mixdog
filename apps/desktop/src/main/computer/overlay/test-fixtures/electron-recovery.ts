import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createComputerUseOverlay } from '../index';
import { computerUseCoordinator as coordinator } from '../../session/coordinator';
import { nativeOverlayClick } from './native-click';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.OVERLAY_TEST_DIRECTORY!, 'profile'));
/** Electron's stdio pipes are asynchronous: text written without waiting for its flush is
 * lost when the process exits, which reads in CI as a successful run with no result. */
const emit = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>(resolve => { stream.write(text, () => resolve()); });
// Retiring the frozen renderer leaves this fixture with zero windows until the replacement
// exists. Without this listener Electron's default quit-on-last-window-close runs the whole
// quit sequence right there, the process exits 0 before any result or diagnostic is written,
// and app.exit(1) from the rejection handler can no longer change that exit code.
app.on('window-all-closed', () => {
  void emit(process.stderr, 'OVERLAY_WINDOWS_ALL_CLOSED\n');
});

const nextWindow = () => new Promise<BrowserWindow>(resolve => {
  app.once('browser-window-created', (_event, window) => resolve(window));
});
const shown = (window: BrowserWindow) => window.isVisible() ? Promise.resolve()
  : new Promise<void>(resolve => window.once('show', () => resolve()));

void app.whenReady().then(async () => {
  const initialWindow = nextWindow();
  let resumed = 0;
  let resumeReceived: (() => void) | undefined;
  const overlay = createComputerUseOverlay({
    stop: async () => {},
    resume: async generation => {
      resumed++;
      coordinator.resumeAfterUserTakeover(generation);
      resumeReceived?.();
    },
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
      const button = document.getElementById('toggle');
      if (button.disabled || button.getAttribute('aria-label') !== '재개') throw new Error('replacement Resume unavailable');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 4) };
    })()`);
    const [x, y] = replacement.getPosition();
    const handle = replacement.getNativeWindowHandle();
    const acknowledged = new Promise<void>(resolve => { resumeReceived = resolve; });
    const clickMode = await nativeOverlayClick(
      handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
      screen.dipToScreenPoint({ x: x + point.x, y: y + point.y }),
    );
    await emit(process.stderr, `OVERLAY_CLICK_MODE ${clickMode}\n`);
    await acknowledged;
    assert.equal(replacement.isVisible(), true);
    assert.equal(coordinator.snapshot().userControlActive, false);
    assert.equal(resumed, 1);
    await emit(process.stdout, `OVERLAY_RESULT ${JSON.stringify({
      retired: hung.isDestroyed(), visible: replacement.isVisible(),
      inputBlocked: coordinator.snapshot().userControlActive, resumed,
    })}\n`);
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
  // app.quit() would hand the exit code to the quit sequence; exit only after the flush above.
  app.exit(0);
}).catch(async error => {
  await emit(process.stderr, `${(error as Error)?.stack || String(error)}\n`);
  app.exit(1);
});
