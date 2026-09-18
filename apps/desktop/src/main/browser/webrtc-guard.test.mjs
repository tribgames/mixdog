import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_WEBRTC_BLOCK_SCRIPT, browserPageGuardScripts } from './webrtc-guard.ts';

function install(window) {
  new Function('window', `return ${BROWSER_WEBRTC_BLOCK_SCRIPT}`)(window);
  return window;
}

test('a restricted page cannot open a peer connection under any of its names', () => {
  const original = class RealPeerConnection {};
  const window = install({
    RTCPeerConnection: original,
    webkitRTCPeerConnection: original,
    mozRTCPeerConnection: original,
  });

  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    assert.notEqual(window[name], original, `${name} must not stay reachable`);
    assert.throws(() => new window[name](), /blocked by the Browser Use domain policy/);
  }
  // Installing twice must not capture the refusing stub as the "original".
  install(window);
  assert.throws(() => new window.RTCPeerConnection(), /blocked by the Browser Use domain policy/);
});

test('guards are installed only where an operator restricted the domains', () => {
  assert.deepEqual(browserPageGuardScripts({}), []);
  assert.deepEqual(browserPageGuardScripts({ allowedDomains: [] }), []);
  assert.deepEqual(browserPageGuardScripts({ allowedDomains: ['example.test'] }), [BROWSER_WEBRTC_BLOCK_SCRIPT]);
});
