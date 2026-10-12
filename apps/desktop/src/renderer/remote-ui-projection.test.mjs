import assert from 'node:assert/strict';
import test from 'node:test';
import { isElectronRenderer, isNativeDesktopWindow, isRemoteHostRenderer } from './remote-ui-projection.ts';

function withGlobals(values, run) {
  const saved = new Map();
  for (const key of Object.keys(values)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('remote host detection follows the shim, not the user agent', () => {
  const electron = { userAgent: 'Mozilla/5.0 Electron/40.8.4' };
  withGlobals({ window: { mixdogRemoteServer: 'https://relay.test' }, navigator: electron }, () => {
    assert.equal(isRemoteHostRenderer(), true);
    assert.equal(isElectronRenderer(), true);
    assert.equal(isNativeDesktopWindow(), false);
  });
  withGlobals({ window: {}, navigator: { userAgent: 'Mozilla/5.0 Safari' } }, () => {
    assert.equal(isRemoteHostRenderer(), false);
    assert.equal(isElectronRenderer(), false);
  });
  withGlobals({ window: { mixdogDesktop: { bootContext: { bootId: 'b' } } }, navigator: electron }, () => {
    assert.equal(isNativeDesktopWindow(), true);
  });
});
