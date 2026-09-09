import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { computerUseCoordinator as coordinator } from '../../session/coordinator';
import { createComputerUseCursorOverlay } from '../cursor-overlay';
import { prepareCursorFeedback } from '../cursor-readiness';
import { CURSOR_HOTSPOT } from '../cursor-art';

app.disableHardwareAcceleration();
app.setPath('userData', join(process.env.CURSOR_TEST_DIRECTORY!, 'profile'));
void app.whenReady().then(async () => {
  const overlay = createComputerUseCursorOverlay();
  try {
    coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'background' });
    coordinator.showCursor({ sessionId: 'fixture', action: 'click', mode: 'background',
      effect: 'click', x: 100, y: 100 });
    assert.equal(await prepareCursorFeedback('fixture'), 'unavailable');
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'background work must not create a topmost effect window');
    coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'foreground' });
    assert.equal(await prepareCursorFeedback('fixture', 2000), 'ready');
    let window = BrowserWindow.getAllWindows()[0];
    assert.ok(window);
    assert.equal(window.isVisible(), false, 'preparation must not flash or steal focus');
    assert.equal(window.isFocusable(), false);
    for (const display of screen.getAllDisplays()) {
      const point = screen.dipToScreenPoint({
        x: display.workArea.x + 100, y: display.workArea.y + 100,
      });
      coordinator.showCursor({ sessionId: 'fixture', action: 'move', mode: 'foreground',
        effect: 'move', tracking: true, ...point });
      const deadline = Date.now() + 2000;
      while (!window.isVisible() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(window.isVisible(), true);
      // Wait for the render started by showCursor to apply this display's bounds.
      const expected = screen.screenToDipPoint(point);
      while (Math.abs(window.getBounds().x + CURSOR_HOTSPOT - expected.x) > 1 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const bounds = window.getBounds();
      assert.ok(Math.abs(bounds.x + CURSOR_HOTSPOT - expected.x) <= 1);
      assert.ok(Math.abs(bounds.y + CURSOR_HOTSPOT - expected.y) <= 1);
    }
    coordinator.beginCommand({ sessionId: 'other', action: 'click', mode: 'background' });
    coordinator.showCursor({ sessionId: 'other', action: 'click', mode: 'background',
      effect: 'click', x: 100, y: 100 });
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'another background session must not draw through foreground work');
    coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'background' });
    assert.equal(window.isDestroyed(), true, 'switching to background must drop the old foreground tail');
    coordinator.beginCommand({ sessionId: 'fixture', action: 'click', mode: 'foreground' });
    assert.equal(await prepareCursorFeedback('fixture'), 'ready');
    window = BrowserWindow.getAllWindows()[0];
    assert.equal(window.isVisible(), false, 'old cursor feedback must not reappear on a mode switch');
    coordinator.pauseForUser('user_input_active');
    assert.equal(window.isDestroyed(), true, 'user takeover must remove the actual effect window');
    overlay.dispose();
    assert.equal(await prepareCursorFeedback('fixture'), 'unavailable');
    coordinator.reset();
    process.stdout.write('CURSOR_LIFECYCLE_OK\n');
  } finally {
    overlay.dispose();
    coordinator.reset();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
