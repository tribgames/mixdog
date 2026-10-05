import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { computerUseCoordinator as coordinator } from '../../session/coordinator';
import { createComputerUseCursorOverlay } from '../cursor-overlay';
import { prepareCursorFeedback } from '../cursor-readiness';
import { CURSOR_HOTSPOT } from '../cursor-art';
import { sleep } from '../../shared/common';
import { requireEnv } from './require-env';

app.disableHardwareAcceleration();
// This fixture has no main app window; removing an effect must not end the test.
app.on('window-all-closed', () => {});
app.setPath('userData', join(requireEnv('CURSOR_TEST_DIRECTORY'), 'profile'));
void app
  .whenReady()
  .then(async () => {
    const overlay = createComputerUseCursorOverlay();
    const target = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true });
    const windowId = `hwnd:0x${BigInt(target.getMediaSourceId().split(':')[1]).toString(16)}`;
    const userFocus = BrowserWindow.getFocusedWindow();
    const effectWindows = () => BrowserWindow.getAllWindows().filter((window) => window !== target);
    const rendered = async (effectWindow: BrowserWindow) => {
      const deadline = Date.now() + 2000;
      while (!effectWindow.isVisible() && Date.now() < deadline) {
        await sleep(10);
      }
      assert.equal(effectWindow.isVisible(), true);
    };
    try {
      for (const mode of ['background', 'foreground'] as const) {
        const sessionId = `completed-${mode}`;
        coordinator.beginCommand({ sessionId, action: 'click', mode });
        assert.equal(await prepareCursorFeedback(sessionId, 2000), 'ready');
        const window = effectWindows()[0];
        coordinator.showCursor({
          sessionId,
          windowId,
          action: 'move',
          mode,
          effect: 'move',
          tracking: true,
          x: 100,
          y: 100,
        });
        await rendered(window);
        coordinator.finishCommand(sessionId);
        assert.equal(window.isVisible(), true, 'a completed short action retains its visual tail');
        const deadline = Date.now() + 2000;
        while (window.isVisible() && Date.now() < deadline) {
          await sleep(10);
        }
        // A foreground session's arrow stands in for the hidden real pointer
        // while it thinks; a background one hides after its visual tail. This
        // runs on the live desktop, where a mouse the user moved ends the hold.
        const yielded = Boolean(coordinator.snapshot().releasedPointerSessionIds?.includes(sessionId));
        assert.equal(
          window.isVisible(),
          mode === 'foreground' && !yielded,
          'only a foreground session keeps its arrow while it thinks'
        );
        assert.equal(coordinator.snapshot().activities[0]?.phase, 'thinking');
        coordinator.endExecution(sessionId);
        assert.equal(window.isDestroyed(), true);
      }
      for (const mode of ['background', 'foreground'] as const) {
        coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode });
        assert.equal(await prepareCursorFeedback('fixture', 2000), 'ready');
        const window = effectWindows()[0];
        assert.ok(window);
        assert.equal(window.isVisible(), false, 'preparation and mode changes must not replay old effects');
        assert.equal(window.isFocusable(), false);
        for (const display of screen.getAllDisplays()) {
          target.setBounds({ x: display.workArea.x, y: display.workArea.y, width: 400, height: 300 });
          target.showInactive();
          const point = screen.dipToScreenPoint({
            x: display.workArea.x + 100,
            y: display.workArea.y + 100,
          });
          coordinator.showCursor({
            sessionId: 'fixture',
            windowId,
            action: 'move',
            mode,
            effect: 'move',
            tracking: true,
            ...point,
          });
          const deadline = Date.now() + 2000;
          while (!window.isVisible() && Date.now() < deadline) {
            await sleep(10);
          }
          assert.equal(window.isVisible(), true);
          // Wait for the render started by showCursor to apply this display's bounds.
          const expected = screen.screenToDipPoint(point);
          while (Math.abs(window.getBounds().x + CURSOR_HOTSPOT - expected.x) > 1 && Date.now() < deadline) {
            await sleep(10);
          }
          const bounds = window.getBounds();
          assert.ok(Math.abs(bounds.x + CURSOR_HOTSPOT - expected.x) <= 1);
          assert.ok(Math.abs(bounds.y + CURSOR_HOTSPOT - expected.y) <= 1);
          assert.equal(
            window.isAlwaysOnTop(),
            mode === 'foreground',
            'background feedback must not be globally topmost'
          );
          // The user can move their own pointer at any moment, so an unchanged
          // position cannot be required of a live desktop. What must never
          // happen is the virtual pointer dragging the real one onto the exact
          // spot it is drawing.
          assert.notDeepEqual(
            screen.getCursorScreenPoint(),
            expected,
            'feedback must not move the user pointer onto its target'
          );
          assert.equal(BrowserWindow.getFocusedWindow(), userFocus, 'feedback must not take focus');
        }
      }
      const window = effectWindows()[0];
      coordinator.beginCommand({ sessionId: 'other', action: 'click', mode: 'background' });
      assert.equal(await prepareCursorFeedback('other', 2000), 'ready');
      coordinator.showCursor({
        sessionId: 'other',
        windowId,
        action: 'click',
        mode: 'background',
        effect: 'click',
        x: 100,
        y: 100,
      });
      const otherWindow = effectWindows().find((candidate) => candidate !== window);
      assert.ok(otherWindow, 'background feedback opens its own effect window');
      await rendered(otherWindow);
      assert.equal(otherWindow.isAlwaysOnTop(), false);
      assert.equal(window.isVisible(), true, 'background feedback must not hide another active session');
      coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'background' });
      assert.equal(window.isVisible(), false, 'switching to background must not revive the old foreground trace');
      coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'foreground' });
      assert.equal(await prepareCursorFeedback('fixture'), 'ready');
      assert.equal(window.isVisible(), false, 'old cursor feedback must not reappear on a mode switch');
      coordinator.showCursor({
        sessionId: 'fixture',
        action: 'move',
        mode: 'foreground',
        effect: 'move',
        x: 100,
        y: 100,
      });
      await rendered(window);
      coordinator.beginCommand({ sessionId: 'next', action: 'move', mode: 'foreground' });
      await prepareCursorFeedback('next', 2000);
      const nextWindow = effectWindows().find((candidate) => candidate !== window && candidate !== otherWindow);
      assert.ok(nextWindow, 'the next session opens its own effect window');
      coordinator.showCursor({ sessionId: 'next', action: 'move', mode: 'foreground', effect: 'move', x: 200, y: 100 });
      await rendered(nextWindow);
      assert.equal(window.isVisible(), false, 'new physical pointer owner hides the old halo');
      coordinator.finishCommand('next');
      assert.equal(window.isVisible(), false, 'the older active cursor cannot reappear');
      const crashed = new Promise<void>((resolve) => nextWindow.once('closed', () => resolve()));
      nextWindow.webContents.forcefullyCrashRenderer();
      await crashed;
      assert.equal(await prepareCursorFeedback('next', 2000), 'ready');
      const replacement = effectWindows().find((candidate) => candidate !== window && candidate !== otherWindow);
      assert.ok(replacement && replacement !== nextWindow, 'readiness must use a live replacement');
      assert.equal(replacement.isVisible(), false, 'a crash must not replay the previous effect');
      coordinator.showCursor({ sessionId: 'next', action: 'move', mode: 'foreground', effect: 'move', x: 300, y: 100 });
      await rendered(replacement);
      const pointerSample = screen.getCursorScreenPoint();
      await sleep(30);
      const pointerBeforeTakeover = screen.getCursorScreenPoint();
      // Only a settled pointer can show that takeover left it alone; while the
      // user physically moves the mouse, its position proves nothing about this code.
      const pointerSettled = pointerSample.x === pointerBeforeTakeover.x && pointerSample.y === pointerBeforeTakeover.y;
      coordinator.pauseForUser('user_input_active');
      assert.equal(window.isDestroyed(), true, 'user takeover must remove the actual effect window');
      assert.equal(nextWindow.isDestroyed(), true);
      assert.equal(replacement.isDestroyed(), true);
      assert.equal(otherWindow.isDestroyed(), true);
      if (pointerSettled) {
        assert.deepEqual(
          screen.getCursorScreenPoint(),
          pointerBeforeTakeover,
          'user takeover must not move a settled pointer'
        );
      }
      assert.equal(BrowserWindow.getFocusedWindow(), userFocus);
      overlay.dispose();
      assert.equal(await prepareCursorFeedback('fixture'), 'unavailable');
      coordinator.reset();
      process.stdout.write('CURSOR_LIFECYCLE_OK\n');
    } finally {
      overlay.dispose();
      coordinator.reset();
      target.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
