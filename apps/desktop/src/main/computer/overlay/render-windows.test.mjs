import assert from 'node:assert/strict';
import test from 'node:test';
import { renderComputerOverlayWindows } from './render-windows.ts';

const presentation = {
  visible: true, sessionIds: ['session-a'], title: 'Mixdog using', accent: '#58a6ff',
  paused: false, canResume: false, generation: 0, detail: '', busy: false,
  idleResumeSeconds: 5, attention: false,
};

function windowFixture() {
  let visible = false;
  let destroyed = false;
  const pending = [];
  const entry = {
    lastRenderedPresentation: '',
    window: {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      showInactive() {
        assert.equal(destroyed, false, 'must not show a destroyed window');
        visible = true;
      },
      webContents: {
        executeJavaScript() {
          return new Promise((resolve) => { pending.push(resolve); });
        },
      },
    },
  };
  return {
    entry, pending,
    destroy() { destroyed = true; visible = false; },
  };
}

for (const interruption of ['execution ended', 'overlay disposed', 'display removed']) {
  test(`a delayed presentation cannot show the overlay after ${interruption}`, async () => {
    const fixture = windowFixture();
    let current = true;
    const rendering = renderComputerOverlayWindows(
      [fixture.entry], presentation, 1, () => current,
    );
    assert.equal(fixture.entry.window.isVisible(), false);
    if (interruption === 'display removed') fixture.destroy();
    else current = false;
    fixture.pending[0]();
    await rendering;
    assert.equal(fixture.entry.window.isVisible(), false);
  });
}

test('ending execution prevents delayed overlays from appearing on every display', async () => {
  const displays = [windowFixture(), windowFixture()];
  let current = true;
  const rendering = renderComputerOverlayWindows(
    displays.map((display) => display.entry), presentation, 1, () => current,
  );
  current = false;
  for (const display of displays) display.pending[0]();
  await rendering;
  assert.ok(displays.every((display) => !display.entry.window.isVisible()));
});

test('a superseded render cannot show UI while the newer presentation is still pending', async () => {
  const fixture = windowFixture();
  let revision = 1;
  const previous = renderComputerOverlayWindows(
    [fixture.entry], presentation, 1, () => revision === 1,
  );
  revision = 2;
  const latest = renderComputerOverlayWindows(
    [fixture.entry], { ...presentation, paused: true, canResume: true }, 2,
    () => revision === 2,
  );
  fixture.pending[0]();
  await previous;
  assert.equal(fixture.entry.window.isVisible(), false);
  fixture.pending[1]();
  await latest;
  assert.equal(fixture.entry.window.isVisible(), true);
});

test('a new execution can display normally after an earlier render was cancelled', async () => {
  const fixture = windowFixture();
  let revision = 1;
  const ended = renderComputerOverlayWindows(
    [fixture.entry], presentation, 1, () => revision === 1,
  );
  revision = 2;
  fixture.pending[0]();
  await ended;
  assert.equal(fixture.entry.window.isVisible(), false);
  const resumed = renderComputerOverlayWindows(
    [fixture.entry], presentation, 2, () => revision === 2,
  );
  fixture.pending[1]();
  await resumed;
  assert.equal(fixture.entry.window.isVisible(), true);
});

test('a hidden or already superseded presentation never opens a window', async () => {
  const fixture = windowFixture();
  await renderComputerOverlayWindows(
    [fixture.entry], { ...presentation, visible: false }, 1, () => true,
  );
  await renderComputerOverlayWindows(
    [fixture.entry], presentation, 1, () => false,
  );
  assert.equal(fixture.entry.window.isVisible(), false);
  assert.equal(fixture.pending.length, 0);
});
