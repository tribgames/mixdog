import assert from 'node:assert/strict';
import test from 'node:test';

// The phone API installs itself only where nothing else provides window.mixdogDesktop: a relay-served page. Inside the desktop app the
// preload exposes the host half and the window composes the API afterwards, so the install must do nothing there.
test('the phone API is not installed in a window that has the desktop host half', async () => {
  const previous = { window: globalThis.window, WebSocket: globalThis.WebSocket };
  const host = {};
  globalThis.window = { mixdogDesktopHost: host };
  globalThis.WebSocket = class {};
  try {
    const { installPhoneShim } = await import('./remote-shim-boot.ts');
    installPhoneShim([]);
    assert.equal(globalThis.window.mixdogDesktop, undefined);
    assert.equal(globalThis.window.mixdogDesktopHost, host);
  } finally {
    globalThis.window = previous.window;
    globalThis.WebSocket = previous.WebSocket;
  }
});
