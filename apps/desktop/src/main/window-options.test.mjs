import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _markMicaWindowForTest,
  DESKTOP_BACKGROUND_COLOR,
  DESKTOP_LIGHT_BACKGROUND_COLOR,
  setDesktopTitleBarTheme,
  setWindowTitleBarBand,
} from './window-options.ts';

function fakeWindow() {
  const backgrounds = [];
  const overlays = [];
  return {
    backgrounds,
    overlays,
    setBackgroundColor(color) {
      backgrounds.push(color);
    },
    setTitleBarOverlay(overlay) {
      overlays.push(overlay);
    },
  };
}

test('setWindowTitleBarBand updates opaque background colors on non-Mica windows', () => {
  const window = fakeWindow();
  setWindowTitleBarBand(window, true);
  setWindowTitleBarBand(window, false);
  assert.deepEqual(window.backgrounds, [DESKTOP_LIGHT_BACKGROUND_COLOR, DESKTOP_BACKGROUND_COLOR]);
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.deepEqual(
      window.overlays.map((overlay) => overlay.symbolColor),
      ['black', 'white']
    );
  }
});

test('setWindowTitleBarBand preserves clear Mica background matching setDesktopTitleBarTheme', () => {
  const window = fakeWindow();
  _markMicaWindowForTest(window);

  setDesktopTitleBarTheme(window, 'light');
  setWindowTitleBarBand(window, true);
  setWindowTitleBarBand(window, false);

  assert.deepEqual(window.backgrounds, ['#00000000', '#00000000', '#00000000']);
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.deepEqual(
      window.overlays.map((overlay) => overlay.symbolColor),
      ['black', 'black', 'white']
    );
  }
});
