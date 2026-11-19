import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserCommandRunner } from './agent-bridge.ts';

// The idle reclaim of background pages is owned by the browser host's own
// timer; the bridge connection coming and going must not start or stop one.
test('the command runner owns no timer: the bridge going inactive cannot stop the page reclaim', () => {
  const intervals = [];
  const original = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    intervals.push(args);
    return original(...args);
  };
  try {
    const runner = createBrowserCommandRunner({
      chains: new Map(),
      pendingReads: new Map(),
      visibleGuests: () => [],
      lifecycle: { attachDebuggerEagerly() {}, destroyAllBackgroundPages() {} },
    });
    runner.begin();
    runner.ready();
    runner.inactive();
    runner.ready();
  } finally {
    globalThis.setInterval = original;
  }
  assert.equal(intervals.length, 0);
});
