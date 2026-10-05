import { app, type BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createComputerUseOverlay } from '../index';
import { computerUseCoordinator as coordinator } from '../../session/coordinator';
import { nativeOverlayClick } from './native-click';
import { emit } from './process-output';
import { requireEnv } from './require-env';

if (process.env.OVERLAY_SOFTWARE_RENDERING === '1') app.disableHardwareAcceleration();
app.setPath('userData', join(requireEnv('OVERLAY_TEST_DIRECTORY'), 'profile'));
// Retiring the frozen renderer leaves this fixture with zero windows until the replacement
// exists. Without this listener Electron's default quit-on-last-window-close runs the whole
// quit sequence right there, the process exits 0 before any result or diagnostic is written,
// and app.exit(1) from the rejection handler can no longer change that exit code.
app.on('window-all-closed', () => {
  void emit(process.stderr, 'OVERLAY_WINDOWS_ALL_CLOSED\n');
});

const nextWindow = () =>
  new Promise<BrowserWindow>((resolve) => {
    app.once('browser-window-created', (_event, window) => resolve(window));
  });
const shown = (window: BrowserWindow) =>
  window.isVisible() ? Promise.resolve() : new Promise<void>((resolve) => window.once('show', () => resolve()));

void app
  .whenReady()
  .then(async () => {
    const initialWindow = nextWindow();
    let stopped = 0;
    let stopReceived: (() => void) | undefined;
    const overlay = createComputerUseOverlay(
      {
        stop: async () => {
          stopped++;
          coordinator.cancelSession('renderer-hang-fixture');
          coordinator.resumeAfterUserTakeover();
          stopReceived?.();
        },
        pause: async () => {
          coordinator.pauseForUser('user_pause');
        },
      },
      'ko'
    );
    try {
      coordinator.beginCommand({ sessionId: 'renderer-hang-fixture', action: 'capture', mode: 'background' });
      const hung = await initialWindow;
      await shown(hung);
      const enteredHang = new Promise<void>((resolve) => {
        hung.webContents.on('console-message', (event) => {
          if (event.message === 'OVERLAY_HANG_ENTERED') resolve();
        });
      });
      // Freeze only this fixture's renderer. Dispatch the host unresponsive event
      // explicitly so the test does not depend on Chromium's OS hang-detection delay.
      void hung.webContents.executeJavaScript("console.log('OVERLAY_HANG_ENTERED'); for (;;) {}").catch(() => {
        /* Destruction rejects pending script execution. */
      });
      await enteredHang;
      const next = nextWindow();
      hung.emit('unresponsive');
      const replacement = await next;
      await shown(replacement);
      assert.equal(hung.isDestroyed(), true);
      assert.equal(coordinator.snapshot().userControlActive, true);
      assert.equal(stopped, 0);
      assert.equal(replacement.isFocused(), false);
      const visible = replacement.isVisible();

      const point = await replacement.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('stop');
      if (button.disabled || button.getAttribute('aria-label') !== '중단') throw new Error('replacement Stop unavailable');
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 4) };
    })()`);
      const [x, y] = replacement.getPosition();
      const handle = replacement.getNativeWindowHandle();
      const acknowledged = new Promise<void>((resolve) => {
        stopReceived = resolve;
      });
      const clickMode = await nativeOverlayClick(
        handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()),
        screen.dipToScreenPoint({ x: x + point.x, y: y + point.y })
      );
      await emit(process.stderr, `OVERLAY_CLICK_MODE ${clickMode}\n`);
      await acknowledged;
      assert.equal(coordinator.snapshot().userControlActive, false);
      assert.equal(stopped, 1);
      await emit(
        process.stdout,
        `OVERLAY_RESULT ${JSON.stringify({
          retired: hung.isDestroyed(),
          visible,
          inputBlocked: coordinator.snapshot().userControlActive,
          stopped,
        })}\n`
      );
    } finally {
      overlay.dispose();
      coordinator.reset();
    }
    // app.quit() would hand the exit code to the quit sequence; exit only after the flush above.
    app.exit(0);
  })
  .catch(async (error) => {
    await emit(process.stderr, `${(error as Error)?.stack || String(error)}\n`);
    app.exit(1);
  });
